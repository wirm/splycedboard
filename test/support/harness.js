/**
 * Test harness. Require this FIRST in a test file: it points SplycedBoard at a fresh
 * temporary home folder before any src/ module reads its paths.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'splycedboard-test-'));
process.env.SPLYCEDBOARD_HOME = HOME;
process.env.SPLYCEDBOARD_LOG_SILENT = '1';
delete process.env.SPLYCEDBOARD_LOG_DIR;
delete process.env.SPLYCEDBOARD_DATA_DIR;

const DATA_DIR = path.join(HOME, 'data');

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Merge keys into data/<id>/settings.json. */
function patchSettings(id, patch) {
  const file = path.join(DATA_DIR, id, 'settings.json');
  const current = fs.existsSync(file) ? readJson(file) : {};
  writeJson(file, { ...current, ...patch });
}

function setEnabled(map) {
  writeJson(path.join(DATA_DIR, 'hub.json'), {
    integrations: Object.fromEntries(Object.entries(map).map(([id, enabled]) => [id, { enabled }])),
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeout = 5000, interval = 25, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Boot a hub + web server in this process, like src/index.js does. `updates`: an Updater. */
async function startHub({ updates = null } = {}) {
  const { Hub } = require('../../SplycedBoard/src/core/hub');
  const { createWebServer } = require('../../SplycedBoard/src/web/server');
  const hub = new Hub();
  hub.load();
  const web = await createWebServer({
    hub,
    port: 0,
    updates,
    app: { name: 'SplycedBoard', version: 'test', runtime: 'test', managed: false, startedAt: new Date().toISOString() },
  });
  await hub.startEnabled();
  const base = `http://127.0.0.1:${web.server.address().port}`;

  const request = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };

  return {
    hub,
    web,
    base,
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body ?? {}),
    put: (url, body) => request('PUT', url, body ?? {}),
    async stop() {
      await web.close();
      await hub.stopAll();
    },
  };
}

/** Line-oriented TCP client that records everything it receives. */
function tcpClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const lines = [];
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      buf += d;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      lines.push(...parts.filter(Boolean));
    });
    socket.once('error', reject);
    socket.once('connect', () => resolve({
      lines,
      send: (line) => socket.write(line + '\r\n'),
      waitForLine: (match, timeout = 3000) => waitFor(() => lines.find((l) => (typeof match === 'string' ? l === match : match.test(l))), { timeout, what: `line ${match}` }),
      close: () => socket.destroy(),
    }));
  });
}

/** Send raw bytes, collect the reply until the server closes the connection. */
function rawExchange(port, payload, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const socket = net.connect(port, '127.0.0.1', () => {
      connected = true;
      socket.write(payload);
    });
    let out = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('rawExchange timed out')); }, timeout);
    socket.setEncoding('utf8');
    socket.on('data', (d) => { out += d; });
    socket.on('error', (err) => {
      if (connected) return; // reset after connecting just ends the exchange
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

module.exports = { HOME, DATA_DIR, writeJson, readJson, patchSettings, setEnabled, freePort, waitFor, startHub, tcpClient, rawExchange };
