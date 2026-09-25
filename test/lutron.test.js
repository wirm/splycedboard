/**
 * Lutron integration end-to-end against the mock LEAP processor: inventory loading,
 * the Savant profile's HTTP endpoints (new and legacy paths), the telnet bridge,
 * WebSocket events, and switching the integration off and on.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { startMockProcessor, seedDataDir } = require('./support/mock-leap');

let mock;
let hub;
let telnetPort;

const commandsTo = (url) => mock.received.filter((r) => r.type === 'CreateRequest' && r.url === url);
const lastCommandTo = (url) => commandsTo(url).at(-1)?.body?.Command;
const zoneLevel = (id) => mock.state.zones.find((z) => z.id === id).level;
const waitReady = () => h.waitFor(async () => (await hub.get('/api/lutron/status')).json?.ready, { what: 'Lutron ready' });

before(async () => {
  mock = await startMockProcessor();
  seedDataDir(h.DATA_DIR, mock.port);
  telnetPort = await h.freePort();
  h.patchSettings('lutron', { telnetPort });
  h.setEnabled({ lutron: true, scli: false });
  hub = await h.startHub();
  await waitReady();
});

after(async () => {
  await hub?.stop();
  await mock?.close();
});

test('loads the QSX inventory through the per-area fallbacks', async () => {
  const { status, json: inv } = await hub.get('/api/lutron/inventory');
  assert.equal(status, 200);

  const types = Object.fromEntries(inv.zones.map((z) => [z.id, z.type]));
  assert.deepEqual(types, { 101: 'dimmer', 102: 'switch', 201: 'shade', 202: 'ketra', 203: 'fan', 301: 'rania', 302: 'hvac' });
  assert.equal(inv.zones.find((z) => z.id === 101).areaName, 'Kitchen');
  assert.equal(inv.zones.find((z) => z.id === 101).level, 75);

  assert.equal(inv.buttonGroups.length, 1);
  assert.equal(inv.buttonGroups[0].deviceId, 501);
  assert.deepEqual(inv.buttonGroups[0].buttons.map((b) => b.name), ['Welcome', 'Cooking', 'All Off']);

  assert.equal(inv.virtualButtons.length, 3);
  assert.equal(inv.thermostats.length, 1);
  assert.equal(inv.thermostats[0].temperature, 71);
});

test('hub reports Lutron as connected', async () => {
  const { json } = await hub.get('/api/hub');
  const lutron = json.integrations.find((i) => i.id === 'lutron');
  assert.equal(lutron.running, true);
  assert.equal(lutron.status.level, 'ok');
  assert.match(lutron.status.text, /Mock QSX.*7 zones/);
});

test('QueryDimmerLevel answers on both the new and the legacy path', async () => {
  for (const url of ['/api/lutron/zone/query?id=101', '/api/zone/query?id=101']) {
    const { status, json } = await hub.get(url);
    assert.equal(status, 200, url);
    assert.deepEqual(json, { level: 75 }, url);
  }
  assert.equal((await hub.get('/api/zone/query?id=999')).status, 404);
  assert.equal((await hub.get('/api/zone/query')).status, 400);
});

test('zone, area, shade and scene endpoints drive the processor', async () => {
  assert.equal((await hub.get('/api/lutron/zone/level?id=101&level=30&fade=1')).status, 200);
  assert.deepEqual(lastCommandTo('/zone/101/commandprocessor'), { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: 30 }] });
  await h.waitFor(async () => (await hub.get('/api/zone/query?id=101')).json.level === 30, { what: 'level feedback' });

  assert.equal((await hub.get('/api/zone/level?id=101')).status, 400, 'missing level is rejected, not sent as NaN');

  await hub.get('/api/zone/raise?id=101');
  assert.equal(lastCommandTo('/zone/101/commandprocessor').Parameter[0].Value, 35);

  await hub.get('/api/shade/level?id=201&level=80&delay=0');
  assert.equal(zoneLevel(201), 80);

  await hub.get('/api/area/level?id=1&level=10');
  assert.equal(lastCommandTo('/area/1/commandprocessor').Parameter[0].Value, 10);

  await hub.get('/api/scene/recall?id=1');
  assert.deepEqual(lastCommandTo('/virtualbutton/1/commandprocessor'), { CommandType: 'PressAndRelease' });
  await h.waitFor(async () => (await hub.get('/api/zone/query?id=102')).json.level === 0, { what: 'All Off' });
});

test('DimmerSet with no color values is a plain level — 0 turns the light off', async () => {
  await hub.get('/api/lutron/zone/level?id=101&level=60');
  await h.waitFor(async () => (await hub.get('/api/zone/query?id=101')).json.level === 60, { what: 'level 60' });

  const res = await hub.get('/api/color?id=101&level=0&r=&g=&b=&w=&fade=1');
  assert.equal(res.status, 200);
  assert.deepEqual(lastCommandTo('/zone/101/commandprocessor'), { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: 0 }] });
  assert.equal(zoneLevel(101), 0);
});

test('color wheel: level 0 keeps the current brightness', async () => {
  await hub.get('/api/lutron/zone/level?id=202&level=40');
  await h.waitFor(async () => (await hub.get('/api/zone/query?id=202')).json.level === 40, { what: 'ketra 40' });

  const { json } = await hub.get('/api/color?id=202&level=0&r=255&g=0&b=0&w=0');
  assert.equal(json.level, 40);
  const cmd = lastCommandTo('/zone/202/commandprocessor');
  assert.equal(cmd.CommandType, 'GoToSpectrumTuningLevel');
  assert.equal(cmd.SpectrumTuningLevelParameters.Level, 40);
  assert.deepEqual(cmd.SpectrumTuningLevelParameters.ColorTuningStatus, { HSVTuningLevel: { Hue: 0, Saturation: 100 } });
});

test('CCT slider maps 0–100 to 1400–10000 K', async () => {
  const { json } = await hub.get('/api/cct?id=301&level=50');
  assert.equal(json.kelvin, 5700);
  const cmd = lastCommandTo('/zone/301/commandprocessor');
  assert.deepEqual(cmd.SpectrumTuningLevelParameters.ColorTuningStatus, { WhiteTuningLevel: { Kelvin: 5700 } });
});

test('thermostat status and setpoints', async () => {
  const { json } = await hub.get('/api/hvac/status?id=302');
  assert.deepEqual(json, {
    id: 302, name: 'Primary Thermostat', areaName: 'Primary Suite',
    temperature: '71', heatSetpoint: '68', coolSetpoint: '76', mode: 'Auto', fanMode: 'Auto', operatingState: 'Idle',
  });

  await hub.get('/api/hvac/heat?id=302&setpoint=70');
  await hub.get('/api/hvac/fan?mode=High&id=302');
  await h.waitFor(async () => {
    const s = (await hub.get('/api/hvac/status?id=302')).json;
    return s.heatSetpoint === '70' && s.fanMode === 'High';
  }, { what: 'hvac feedback' });
  assert.equal((await hub.get('/api/hvac/mode?id=302')).status, 400);
});

test('keypad buttons by device + button number', async () => {
  const before = mock.received.length;
  assert.equal((await hub.get('/api/button?device=501&num=2&action=pressrelease')).status, 200);
  const sent = mock.received.slice(before).filter((r) => r.url === '/button/702/commandprocessor').map((r) => r.body.Command.CommandType);
  assert.deepEqual(sent, ['PressAndHold', 'Release']);
  assert.equal((await hub.get('/api/button?device=501&num=9')).status, 404);
});

test('lighting export is a plist with every light', async () => {
  const res = await hub.get('/api/lutron/export/lighting');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /lighting_export\.plist/);
  for (const name of ['Kitchen Cans', 'Pendants', 'Cove Ketra', 'Ceiling Fan', 'Vanity Rania']) assert.ok(res.text.includes(name), name);
  assert.ok(!res.text.includes('Window Shades'), 'shades are not lighting rows');
  assert.ok(!res.text.includes('Primary Thermostat'), 'thermostats are not lighting rows');
});

test('telnet bridge: initial state, commands, queries and LED feedback', async () => {
  const client = await h.tcpClient(telnetPort);
  try {
    await client.waitForLine(/^~SHADEGRP,201,1,\d+\.$/);

    client.send('#OUTPUT,102,1,100');
    await client.waitForLine('~OUTPUT,102,1,100.');
    assert.equal(zoneLevel(102), 100);

    client.send('?SHADEGRP,201');
    client.send('?OUTPUT,9999'); // unknown zone: ignored, must not crash the service
    client.send('#DEVICE,501,1,3');
    await client.waitForLine('~DEVICE,501,1,09,01');

    client.send('QNET> #output,101,1,45');
    await client.waitForLine('~OUTPUT,101,1,45.');
  } finally {
    client.close();
  }
  assert.equal((await hub.get('/api/hub')).status, 200, 'still alive');
});

test('dashboard WebSocket gets integration status and live zone updates', async () => {
  const ws = new WebSocket(hub.base.replace('http', 'ws') + '/ws');
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  await new Promise((r) => ws.once('open', r));
  try {
    await h.waitFor(() => messages.find((m) => m.source === 'hub' && m.type === 'integrations'), { what: 'integrations message' });
    await h.waitFor(() => messages.find((m) => m.source === 'lutron' && m.type === 'status' && m.ready), { what: 'lutron hello' });

    await hub.get('/api/zone/level?id=101&level=12');
    const update = await h.waitFor(() => messages.find((m) => m.type === 'zoneUpdate' && m.zone.id === 101 && m.zone.level === 12), { what: 'zoneUpdate' });
    assert.equal(update.source, 'lutron');
  } finally {
    ws.close();
  }
});

test('switching Lutron off closes its ports and APIs; on brings them back', async () => {
  let res = await hub.put('/api/hub/integrations/lutron', { enabled: false });
  assert.equal(res.json.running, false);
  assert.equal(res.json.status.level, 'off');

  res = await hub.get('/api/zone/query?id=101');
  assert.equal(res.status, 503);
  assert.match(res.json.error, /disabled/);
  await assert.rejects(h.tcpClient(telnetPort), /ECONNREFUSED/);

  res = await hub.put('/api/hub/integrations/lutron', { enabled: true });
  assert.equal(res.json.running, true);
  await waitReady();
  assert.equal((await hub.get('/api/zone/query?id=101')).status, 200);
});

test('reconnects after the processor drops the connection', async () => {
  mock.dropConnections();
  await h.waitFor(async () => !(await hub.get('/api/lutron/status')).json.connected, { what: 'disconnect' });
  await h.waitFor(async () => (await hub.get('/api/lutron/status')).json.ready, { timeout: 8000, what: 'reconnect' });
  assert.equal((await hub.get('/api/zone/query?id=101')).status, 200);
});
