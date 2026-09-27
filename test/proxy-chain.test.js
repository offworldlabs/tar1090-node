// Tests for the upstream chain in proxy/server.js.
//
// Run: node --test test/proxy-chain.test.js
//
// The proxy is a script with no exports, so each case runs it as a child
// process against local fake upstreams and asserts over its HTTP surface.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'proxy', 'server.js');

function aircraft(hex) {
  return { hex, flight: 'TEST123 ', lat: 42.2, lon: -72.7, alt_baro: 30000, seen_pos: 0.4 };
}

// A fake adsb.lol-format upstream that records every hit, so a test can prove
// a source was or was not consulted.
async function fakeUpstream(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const { status = 200, body = { ac: [], total: 0 } } = handler() || {};
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, hits, close: () => server.close() };
}

async function startProxy(env) {
  const port = 34000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PROXY_PORT: String(port),
      ADSBLOL_ENABLED: 'true',
      RECEIVER_LAT: '42.2',
      RECEIVER_LON: '-72.7',
      LOCAL_DATA_PATH: '/nonexistent/aircraft.json',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await get(port, '/health');
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`proxy did not start: ${log}`);
    }
  }
  return { port, stop: () => child.kill() };
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 8000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

test('the first upstream that answers wins, and the second is never consulted', async () => {
  const primary = await fakeUpstream(() => ({ body: { ac: [aircraft('abc123')], total: 1 } }));
  const secondary = await fakeUpstream(() => ({ body: { ac: [aircraft('def456')], total: 1 } }));
  const proxy = await startProxy({ ADSB_UPSTREAMS: `${primary.base},${secondary.base}` });

  try {
    const res = await get(proxy.port, '/data/aircraft.json');
    assert.strictEqual(res.body.aircraft[0].hex, 'abc123');
    assert.strictEqual(res.headers['x-data-source'], primary.host);
    assert.strictEqual(secondary.hits.length, 0);
  } finally {
    proxy.stop(); primary.close(); secondary.close();
  }
});

test('a failing first upstream falls through to the second', async () => {
  // adsb.lol refuses most of our requests with 429; that is the case this
  // whole change exists to cover.
  const primary = await fakeUpstream(() => ({ status: 429, body: 'Too Many Requests' }));
  const secondary = await fakeUpstream(() => ({ body: { ac: [aircraft('def456')], total: 1 } }));
  const proxy = await startProxy({ ADSB_UPSTREAMS: `${primary.base},${secondary.base}` });

  try {
    const res = await get(proxy.port, '/data/aircraft.json');
    assert.strictEqual(res.body.aircraft[0].hex, 'def456');
    assert.strictEqual(res.headers['x-data-source'], secondary.host);
  } finally {
    proxy.stop(); primary.close(); secondary.close();
  }
});

test('a local receiver wins over every remote source', async () => {
  const localPath = path.join(os.tmpdir(), `local-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(localPath, JSON.stringify({
    now: Date.now() / 1000,
    messages: 42,
    aircraft: [{ hex: 'local01', lat: 42.2, lon: -72.7, gs: 200, track: 90, seen_pos: 0.2 }]
  }));
  const primary = await fakeUpstream(() => ({ body: { ac: [aircraft('abc123')], total: 1 } }));
  const proxy = await startProxy({ ADSB_UPSTREAMS: primary.base, LOCAL_DATA_PATH: localPath });

  try {
    const res = await get(proxy.port, '/data/aircraft.json');
    assert.strictEqual(res.body.aircraft[0].hex, 'local01');
    assert.strictEqual(res.headers['x-data-source'], 'local');
    assert.strictEqual(primary.hits.length, 0, 'no upstream may be polled when a receiver has data');
  } finally {
    proxy.stop(); primary.close(); fs.unlinkSync(localPath);
  }
});

test('the chain shares one time budget rather than one timeout per source', async () => {
  // Two sources must not add up past blah2-api's 5 s client timeout.
  const hang = http.createServer(() => {});
  await new Promise(r => hang.listen(0, '127.0.0.1', r));
  const hangBase = `http://127.0.0.1:${hang.address().port}`;
  const proxy = await startProxy({
    ADSB_UPSTREAMS: `${hangBase},${hangBase}`,
    ADSBLOL_TIMEOUT_MS: '1000'
  });

  try {
    const started = Date.now();
    await get(proxy.port, '/data/aircraft.json');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `chain took ${elapsed} ms, budget was 1000 ms`);
  } finally {
    proxy.stop(); hang.close();
  }
});

test('a node told nothing stays on adsb.lol alone', async () => {
  const proxy = await startProxy({});
  try {
    await get(proxy.port, '/health');
  } finally {
    proxy.stop();
  }
});
