/**
 * DSC PowerSeries Pro (ITv2): the whole session against a simulated communicator — the
 * handshake for both encryption types, status, arm/disarm, and the dashboard's API.
 * Remove with src/integrations/dsc/.
 */
const h = require('./support/harness');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Itv2Session } = require('../SplycedBoard/src/integrations/dsc/itv2/session');
const { PanelState } = require('../SplycedBoard/src/integrations/dsc/panel');
const { connectMockPanel } = require('./support/mock-dsc');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const FAST = { quietMs: 30, pollMs: 60 * 1000, responseMs: 2000 };

async function session(opts = {}) {
  const port = await h.freePort();
  const panel = new PanelState();
  const messages = [];
  const s = new Itv2Session({
    log: quiet, panel, port,
    integrationId: opts.integrationId ?? '123456789012',
    accessCode: opts.accessCode ?? '12345678',
    timing: FAST,
    onMessage: (m) => messages.push(m),
  });
  await s.start();
  return { s, panel, port, messages };
}

for (const type of [1, 2]) {
  test(`type ${type}: the panel dials in, the session opens encrypted, and status fills in`, async (t) => {
    const accessCode = type === 1 ? '12345678' : '0123456789ABCDEF0123456789ABCDEF';
    const { s, panel, port, messages } = await session({ accessCode });
    const mock = connectMockPanel({ port, type, accessCode });
    t.after(async () => { await mock.close(); await s.stop(); });

    await h.waitFor(() => mock.panel.ready && s.status().connected, { what: 'session open' });
    assert.equal(s.status().encryption, `AES-128-ECB, type ${type}`);
    assert.equal(s.status().panelId, '123456789012');
    assert.ok(mock.panel.headers.every((hd) => hd === '123456789012'), 'every message carries the panel\'s header back');

    // After the quiet period: capabilities, labels, zones, partitions
    await h.waitFor(() => panel.partition(2).ready === true && panel.zone(1).label === 'Front Dr', { what: 'status' });
    assert.equal(panel.info.maxZones, 8);
    assert.equal(panel.zone(2).label, 'Kitchen');
    assert.equal(panel.partition(1).arming, 'disarmed');

    // The panel pushes a zone opening
    mock.panel.notify(0x0210, [1, 3, 1]);
    await h.waitFor(() => panel.zone(3).open === true, { what: 'zone 3 open' });

    // Arm away with the right code; disarm with a wrong one
    assert.equal(await s.arm(1, 'away', '1234'), 'Success');
    await h.waitFor(() => panel.partition(1).arming === 'away', { what: 'armed away' });
    await assert.rejects(s.disarm(1, '9999'), /Invalid access code/);
    assert.equal(await s.disarm(1, '1234'), 'Success');
    await h.waitFor(() => panel.partition(1).arming === 'disarmed', { what: 'disarmed' });

    const log = JSON.stringify(messages);
    assert.ok(!/12 34|99 99/.test(log), 'user codes never reach the log');
    assert.match(log, /code masked/);
  });
}

test('a wrong integration ID or access code is caught during the handshake', async (t) => {
  // Type 1: the panel's key is checked with the integration ID…
  const a = await session({ integrationId: '999999999999' });
  const mockA = connectMockPanel({ port: a.port, type: 1 });
  t.after(async () => { await mockA.close(); await a.s.stop(); });
  await h.waitFor(() => a.messages.some((m) => /doesn't check out/.test(m.text)), { what: 'ID mismatch reported' });
  assert.equal(a.s.status().connected, false);

  // …and ours, by the panel, with the access code
  const b = await session({ accessCode: '87654321' });
  const mockB = connectMockPanel({ port: b.port, type: 1 });
  t.after(async () => { await mockB.close(); await b.s.stop(); });
  await h.waitFor(() => b.messages.some((m) => /check the access code/.test(m.text)), { what: 'access code refused' });
  assert.equal(b.s.status().connected, false);
});

test('a type 3 offer (communicator firmware 5.63) is declined, and the panel falls back', async (t) => {
  const { s, port, messages } = await session();
  const mock = connectMockPanel({ port, type: 1, offerType3: true });
  t.after(async () => { await mock.close(); await s.stop(); });
  await h.waitFor(() => s.status().connected, { what: 'session open after the fallback' });
  assert.ok(messages.some((m) => /declined/.test(m.text)));
});

test('the dashboard: settings, state, arm and the message log over HTTP', async (t) => {
  const port = await h.freePort();
  h.patchSettings('dsc', { port, integrationId: '123456789012', accessCode: '12345678' });
  h.writeJson(path.join(h.DATA_DIR, 'hub.json'), { beta: true, integrations: { dsc: { enabled: true }, lutron: { enabled: false }, scli: { enabled: false } } });
  const hub = await h.startHub();
  const mock = connectMockPanel({ port, type: 1 });
  t.after(async () => { await mock.close(); await hub.stop(); });

  await h.waitFor(async () => (await hub.get('/api/dsc/state')).json.status.connected, { what: 'connected', timeout: 8000 });
  await h.waitFor(async () => (await hub.get('/api/dsc/state')).json.panel.zones.length === 8, { what: 'zones', timeout: 8000 });
  const state = (await hub.get('/api/dsc/state')).json;
  assert.equal(state.settings.accessCodeSet, true);
  assert.equal(state.settings.accessCode, undefined, 'the access code never goes back to the dashboard');

  assert.equal((await hub.post('/api/dsc/arm', { partition: 1, mode: 'stay', code: '1234' })).json.result, 'Success');
  assert.equal((await hub.post('/api/dsc/arm', { partition: 1, mode: 'sideways', code: '1234' })).status, 400);
  assert.equal((await hub.post('/api/dsc/disarm', { partition: 1, code: '12' })).status, 400);
  const bad = await hub.post('/api/dsc/disarm', { partition: 1, code: '0000' });
  assert.deepEqual([bad.status, bad.json.error], [409, 'Invalid access code']);

  const { messages } = (await hub.get('/api/dsc/messages')).json;
  assert.ok(messages.some((m) => m.dir === 'out' && /Arm stay/.test(m.text)));
  assert.ok(!JSON.stringify(messages).includes('12 34'), 'no user code in the log');

  const res = await hub.put('/api/dsc/settings', { integrationId: '12345', accessCode: '' });
  assert.equal(res.status, 400, 'a short integration ID is refused');
});
