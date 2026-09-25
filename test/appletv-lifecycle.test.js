/**
 * Apple TV lifecycle edge cases (regressions from review): switching off mid-operation must
 * never lose pairings, commands to one Apple TV run in order, a retry never kills the fresh
 * connection, state resets on disconnect, and pairing requests can't overlap.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');

// Must be stubbed before the hub loads the integration (device.js grabs probe at load).
const discovery = require('../SplycedBoard/src/integrations/appletv/discovery');
let probeResult = null;
let probeCalls = 0;
discovery.probe = async () => {
  probeCalls++;
  await new Promise((r) => setTimeout(r, 600));
  return probeResult;
};

const { startMockAppleTv } = require('./support/mock-appletv');

const SETTINGS = path.join(h.DATA_DIR, 'appletv', 'settings.json');
let hub;
const mocks = {};

const status = async (ip) => (await hub.get(`/api/appletv/status?ip=${ip}`)).json;
const waitConnected = (ip) => h.waitFor(async () => (await status(ip))?.connected === 'true', { timeout: 8000, what: `${ip} connected` });
const savedCount = () => h.readJson(SETTINGS).devices.length;

async function pair(ip, mock) {
  assert.equal((await hub.post('/api/appletv/pair/start', { ip, host: '127.0.0.1', port: mock.port })).status, 200);
  assert.equal((await hub.post('/api/appletv/pair/finish', { ip, pin: '1234' })).status, 200);
  await waitConnected(ip);
}

before(async () => {
  mocks.a = await startMockAppleTv();
  mocks.b = await startMockAppleTv({ answersAttention: false });
  h.setEnabled({ lutron: false, scli: false, appletv: true });
  hub = await h.startHub();
  await pair('10.1.0.1', mocks.a);
  await pair('10.1.0.2', mocks.b);
});

after(async () => {
  await hub?.stop();
  for (const m of Object.values(mocks)) await m.close();
});

test('overlapping pairing requests get 409 instead of racing', async () => {
  const mock = await startMockAppleTv();
  try {
    const body = { ip: '10.1.0.9', host: '127.0.0.1', port: mock.port };
    const [first, second] = await Promise.all([hub.post('/api/appletv/pair/start', body), hub.post('/api/appletv/pair/start', body)]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(mock.state.pinShown, 1, 'only one PIN prompt on the TV');

    const [f1, f2] = await Promise.all([
      hub.post('/api/appletv/pair/finish', { ip: '10.1.0.9', pin: '1234' }),
      hub.post('/api/appletv/pair/finish', { ip: '10.1.0.9', pin: '1234' }),
    ]);
    assert.deepEqual([f1.status, f2.status].sort(), [200, 409]);
    await waitConnected('10.1.0.9');
    const list = (await hub.get('/api/appletv/devices')).json.devices;
    await fetch(`${hub.base}/api/appletv/devices/${list.find((d) => d.address === '10.1.0.9').id}`, { method: 'DELETE' });
  } finally {
    await mock.close();
  }
});

test('commands to one Apple TV run in order, even while it is reconnecting', async () => {
  mocks.a.dropConnections();
  mocks.a.clearLog();
  // Fired concurrently, so they may arrive in any order — but each press must finish
  // (down, then its up) before the next one starts.
  const results = await Promise.all(['select', 'down', 'right'].map((cmd) => hub.get(`/api/appletv/cmd?ip=10.1.0.1&cmd=${cmd}`)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  const hid = mocks.a.state.hid;
  assert.equal(hid.length, 6);
  for (let i = 0; i < hid.length; i += 2) assert.deepEqual([hid[i][1], hid[i + 1][1], hid[i][0] === hid[i + 1][0]], [1, 2, true]);
  assert.deepEqual(hid.filter(([, state]) => state === 1).map(([code]) => code).sort(), [2, 4, 6]);

  // Sent one after another (as Savant does), they arrive in order.
  mocks.a.clearLog();
  for (const cmd of ['left', 'up']) await hub.get(`/api/appletv/cmd?ip=10.1.0.1&cmd=${cmd}`);
  assert.deepEqual(mocks.a.state.hid, [[3, 1], [3, 2], [1, 1], [1, 2]]);
});

test('what we knew about the Apple TV resets when the connection drops', async () => {
  mocks.b.setAttention(3);
  await h.waitFor(async () => (await status('10.1.0.2')).power === 'ON', { what: 'power on' });
  mocks.b.dropConnections();
  await h.waitFor(async () => (await status('10.1.0.2')).power === 'UNKNOWN', { what: 'power reset' });
  await waitConnected('10.1.0.2');
});

test('dashboard keeps getting updates after the integration is switched off and on', async () => {
  await hub.put('/api/hub/integrations/appletv', { enabled: false });
  await hub.put('/api/hub/integrations/appletv', { enabled: true });
  await waitConnected('10.1.0.1');

  const ws = new WebSocket(hub.base.replace('http', 'ws') + '/ws');
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  await new Promise((r) => ws.once('open', r));
  try {
    mocks.a.setAttention(1);
    await h.waitFor(() => messages.find((m) => m.source === 'appletv' && m.type === 'devices'
      && m.devices.find((d) => d.address === '10.1.0.1')?.power === 'off'), { what: 'devices broadcast' });
  } finally {
    ws.close();
  }
});

test('switching off while a port check is pending keeps every pairing', async () => {
  assert.equal(savedCount(), 2);
  probeCalls = 0;
  probeResult = { port: 1 }; // "the port moved" — answered only after the switch-off
  const portBefore = h.readJson(SETTINGS).devices.find((d) => d.address === '10.1.0.1').port;
  await mocks.a.close(); // next reconnect gets ECONNREFUSED → port check
  mocks.a.dropConnections();
  await h.waitFor(() => probeCalls > 0, { timeout: 10000, what: 'port check started' });

  await hub.put('/api/hub/integrations/appletv', { enabled: false });
  await new Promise((r) => setTimeout(r, 1000)); // let the port check finish
  assert.equal(savedCount(), 2, 'pairings still saved');
  assert.equal(h.readJson(SETTINGS).devices.find((d) => d.address === '10.1.0.1').port, portBefore, 'not rewritten after stop');
  probeResult = null;
});
