const http = require('http');
const https = require('https');
const fs = require('fs').promises;

const LOCAL_DATA_PATH = process.env.LOCAL_DATA_PATH || '/run/readsb/aircraft.json';
const ADSBLOL_ENABLED = process.env.ADSBLOL_ENABLED === 'true';
const RECEIVER_LAT = parseFloat(process.env.RECEIVER_LAT || '0');
const RECEIVER_LON = parseFloat(process.env.RECEIVER_LON || '0');
const ADSBLOL_RADIUS = parseInt(process.env.ADSBLOL_RADIUS || '40');
const PORT = parseInt(process.env.PROXY_PORT || '3005');

const ADSBLOL_API = `https://api.adsb.lol/v2/lat/${RECEIVER_LAT}/lon/${RECEIVER_LON}/dist/${ADSBLOL_RADIUS}`;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const timeout = 5000;

    const req = client.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
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

async function fetchAdsbLol() {
  console.log('Fetching from adsb.lol...');
  const adsbLolData = await fetchUrl(ADSBLOL_API);
  const convertedData = convertAdsbLolToReadsb(adsbLolData);
  console.log(`adsb.lol: ${convertedData.aircraft?.length || 0} aircraft`);
  return { data: convertedData, source: 'adsb.lol' };
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
  // Try local file first (readsb writes to /run/readsb/aircraft.json)
  const localData = await readLocalFile();

  if (localData && localData.aircraft?.length > 0) {
    console.log(`Local file: ${localData.aircraft.length} aircraft`);
    return { data: localData, source: 'local' };
  }

  // Try adsb.lol fallback if enabled
  if (ADSBLOL_ENABLED) {
    const reason = localData ? '0 aircraft from local' : 'local file not found';
    console.log(`Falling back to adsb.lol (${reason})...`);
    try {
      return await fetchAdsbLol();
    } catch (fallbackError) {
      console.log(`adsb.lol fallback failed: ${fallbackError.message}`);
    }
  }

  // Return local data even if empty (if we got a response)
  if (localData) {
    return { data: localData, source: 'local' };
  }

  // No data sources available
  throw new Error('No data sources available');
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/data/aircraft.json') {
    try {
      const { data, source } = await getAircraftData();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Data-Source': source
      });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error.message,
        aircraft: [],
        now: Date.now() / 1000
      }));
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
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
  }
});
