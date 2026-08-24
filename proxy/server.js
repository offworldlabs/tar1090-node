const http = require('http');
const https = require('https');
const fs = require('fs').promises;

const LOCAL_DATA_PATH = process.env.LOCAL_DATA_PATH || '/run/readsb/aircraft.json';
const ADSBLOL_ENABLED = process.env.ADSBLOL_ENABLED === 'true';
const RECEIVER_LAT = parseFloat(process.env.RECEIVER_LAT || '0');
const RECEIVER_LON = parseFloat(process.env.RECEIVER_LON || '0');
const ADSBLOL_RADIUS = parseInt(process.env.ADSBLOL_RADIUS || '40');
const PORT = parseInt(process.env.PROXY_PORT || '3005');

// How long an adsb.lol response may be reused before we refetch. Consumers
// correct for staleness by projecting positions forward from the payload's own
// `now`, but blah2-api's lib/extrapolation.js refuses to project more than 5 s,
// so this must stay comfortably inside that budget.
const CACHE_TTL_MS = parseInt(process.env.ADSBLOL_CACHE_TTL_MS || '3000');
// Must stay below the consumer's HTTP timeout (blah2-api uses 5000 ms) so a
// slow upstream degrades into stale-but-served rather than a client timeout.
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.ADSBLOL_TIMEOUT_MS || '3000');
// How long we keep serving the last good response while adsb.lol is failing.
const MAX_STALE_MS = parseInt(process.env.ADSBLOL_MAX_STALE_MS || '60000');
// adsb.lol refuses requests whose User-Agent is missing or too generic, with
// 403 "User-Agent too generic; include valid contact info." Node's https.get
// sends no User-Agent at all unless one is set, so every request failed closed
// - the fallback was dead fleet-wide and looked like an empty sky. Override
// with a real contact address via ADSBLOL_USER_AGENT where one is available.
const USER_AGENT = process.env.ADSBLOL_USER_AGENT ||
  'retina-node/1.0 (+https://github.com/offworldlabs/tar1090-node)';

const ADSBLOL_API = `https://api.adsb.lol/v2/lat/${RECEIVER_LAT}/lon/${RECEIVER_LON}/dist/${ADSBLOL_RADIUS}`;

// Last good adsb.lol response: { payload, fetchedAt }. `payload.now` is the
// fetch time and is never restamped on serve - consumers rely on it to work out
// how stale each position is.
let cache = null;
// Shared promise for an in-progress fetch, so concurrent requests collapse into
// a single upstream call instead of one call each.
let inFlight = null;
// When the last upstream attempt started, recorded regardless of outcome.
// cache.fetchedAt only advances on success, so gating refreshes on it alone
// leaves a failing upstream unthrottled - see getAircraftData().
let lastAttemptAt = 0;

function emptyPayload() {
  return { now: Date.now() / 1000, messages: 0, aircraft: [] };
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, {
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT }
    }, (res) => {
      if (res.statusCode !== 200) {
        // Read the body rather than discarding it: adsb.lol states the reason
        // for a refusal there, and throwing it away is why a hard 403 was
        // indistinguishable from "no aircraft nearby" for as long as it was.
        // Consuming it also drains the socket, which res.resume() did before.
        let err = '';
        res.on('data', chunk => { if (err.length < 200) err += chunk; });
        res.on('end', () => {
          const detail = err.trim().replace(/\s+/g, ' ').slice(0, 120);
          reject(new Error(`HTTP ${res.statusCode}${detail ? ` - ${detail}` : ''}`));
        });
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.on('error', reject);
  });
}

function convertAdsbLolToReadsb(adsbLolData) {
  const aircraft = adsbLolData.ac || [];

  return {
    // Fetch time, not serve time. Consumers subtract each aircraft's seen_pos
    // from this to recover when the position was actually observed.
    now: Date.now() / 1000,
    messages: 0,
    aircraft: aircraft.map(ac => ({
      hex: ac.hex,
      flight: ac.flight?.trim() || '',
      alt_baro: ac.alt_baro === 'ground' ? 'ground' : ac.alt_baro,
      alt_geom: ac.alt_geom,
      gs: ac.gs,
      track: ac.track,
      baro_rate: ac.baro_rate,
      squawk: ac.squawk,
      emergency: ac.emergency,
      category: ac.category,
      lat: ac.lat,
      lon: ac.lon,
      nic: ac.nic,
      rc: ac.rc,
      seen_pos: ac.seen_pos,
      version: ac.version,
      nic_baro: ac.nic_baro,
      nac_p: ac.nac_p,
      nac_v: ac.nac_v,
      sil: ac.sil,
      sil_type: ac.sil_type,
      gva: ac.gva,
      sda: ac.sda,
      mlat: ac.mlat || [],
      tisb: ac.tisb || [],
      messages: ac.messages || 0,
      seen: ac.seen || 0,
      rssi: ac.rssi
    }))
  };
}

// Refreshes the cache, collapsing concurrent callers onto one upstream request.
// Never rejects - a failed refresh leaves the previous cache in place.
function refreshRemote() {
  if (!inFlight) {
    lastAttemptAt = Date.now();
    console.log('Fetching from adsb.lol...');
    inFlight = fetchUrl(ADSBLOL_API)
      .then((raw) => {
        const payload = convertAdsbLolToReadsb(raw);
        cache = { payload, fetchedAt: Date.now() };
        console.log(`adsb.lol: ${payload.aircraft.length} aircraft`);
      })
      .catch((err) => {
        console.log(`adsb.lol fetch failed: ${err.message}`);
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

async function readLocalFile() {
  try {
    const data = await fs.readFile(LOCAL_DATA_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

async function getAircraftData() {
  // A local receiver, when it has anything to say, always wins - and it is read
  // fresh on every request rather than cached, since readsb rewrites it ~1/s.
  const localData = await readLocalFile();

  if (localData && localData.aircraft?.length > 0) {
    return { data: localData, source: 'local', ageMs: 0, stale: false };
  }

  if (!ADSBLOL_ENABLED) {
    return { data: localData || emptyPayload(), source: localData ? 'local' : 'none', ageMs: 0, stale: false };
  }

  // Refresh only when the cached payload has aged out AND we have not already
  // tried within this window. Without the second condition a failing upstream
  // never advances cache.fetchedAt, so `age` stays Infinity and every request
  // starts its own fetch - inFlight collapses concurrent callers but not
  // sequential ones. That reverts to the full client poll rate precisely when
  // adsb.lol is least able to serve it: measured at ~33 upstream requests/min
  // during the 403 outage, against ~14/min once the cache was being populated.
  const cacheAge = cache ? Date.now() - cache.fetchedAt : Infinity;
  const sinceAttempt = Date.now() - lastAttemptAt;
  if (cacheAge >= CACHE_TTL_MS && sinceAttempt >= CACHE_TTL_MS) {
    await refreshRemote();
  }

  if (cache) {
    const servedAge = Date.now() - cache.fetchedAt;
    if (servedAge <= MAX_STALE_MS) {
      return {
        data: cache.payload,
        source: 'adsb.lol',
        ageMs: servedAge,
        stale: servedAge >= CACHE_TTL_MS
      };
    }
  }

  // No usable remote data. Report that honestly rather than passing off an
  // empty sky as a successful read.
  return { data: localData || emptyPayload(), source: 'none', ageMs: 0, stale: false };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/data/aircraft.json') {
    // getAircraftData() is contracted never to throw or reject: readLocalFile()
    // swallows its own errors and refreshRemote() carries an internal .catch.
    // That contract is what makes it safe to call without a try/catch here - in
    // an async http.createServer callback an unhandled rejection surfaces as an
    // unhandledRejection rather than a clean response. Keep it if you edit them.
    const { data, source, ageMs, stale } = await getAircraftData();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Data-Source': source,
      'X-Data-Age-Ms': String(ageMs),
      'X-Data-Stale': stale ? 'true' : 'false'
    });
    res.end(JSON.stringify(data));
  } else if (req.url === '/health') {
    const age = cache ? Date.now() - cache.fetchedAt : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      adsblol: ADSBLOL_ENABLED ? 'enabled' : 'disabled',
      cacheAgeMs: age,
      cachedAircraft: cache ? cache.payload.aircraft.length : 0
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Aircraft data proxy listening on port ${PORT}`);
  console.log(`Local data file: ${LOCAL_DATA_PATH}`);
  console.log(`adsb.lol fallback: ${ADSBLOL_ENABLED ? 'enabled' : 'disabled'}`);
  if (ADSBLOL_ENABLED) {
    console.log(`adsb.lol API: ${ADSBLOL_API}`);
    console.log(`cache TTL: ${CACHE_TTL_MS} ms, upstream timeout: ${UPSTREAM_TIMEOUT_MS} ms`);
  }
});
