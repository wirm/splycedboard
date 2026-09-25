/**
 * Lutron integration end-to-end against the mock LEAP processor: inventory loading,
 * the Savant profile's HTTP endpoints (new and legacy paths) and feedback, the telnet
 * bridge, WebSocket events, and switching the integration off and on.
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

  // Keypads as QSX lists them: groups under /device/:id with only hrefs, each button read on its own
  const [entry, bedside] = [501, 502].map((id) => inv.buttonGroups.find((g) => g.deviceId === id));
  assert.deepEqual([entry.deviceName, entry.areaName, entry.deviceType, entry.model, entry.family.id], ['Entry', 'Kitchen', 'SeeTouchKeypad', 'HQWD-W4S', 'seetouch']);
  assert.deepEqual(entry.buttons.map((b) => [b.number, b.name, b.role]), [
    [1, 'Welcome', 'button'], [2, 'Cooking', 'button'], [3, 'Dinner', 'button'], [4, 'Night', 'button'],
    [6, 'All Off', 'button'], [18, 'Button 18', 'lower'], [19, 'Button 19', 'raise'],
  ]);
  assert.deepEqual(entry.buttons.map((b) => [b.ledId, b.ledState]).slice(0, 5), [[801, 'Off'], [802, 'Off'], [803, 'Off'], [804, 'Off'], [806, 'On']], 'LED states from their subscriptions');
  assert.deepEqual(entry.rows, [
    { type: 'button', id: 701 }, { type: 'button', id: 702 }, { type: 'button', id: 703 }, { type: 'button', id: 704 },
    { type: 'gap' }, { type: 'button', id: 706 }, { type: 'pair', lower: 718, raise: 719 },
  ], 'the 4-scene seeTouch keeps its gap above Off, raise/lower at the bottom');
  assert.deepEqual([bedside.deviceName, bedside.family.id, bedside.buttons[1].name], ['Bedside', 'palladiom', 'Button 2']);
  assert.deepEqual(bedside.rows.at(-1), { type: 'pair', lower: 716, raise: 717 });
  assert.equal(mock.received.filter((r) => r.type === 'SubscribeRequest' && /^\/led\/\d+\/status$/.test(r.url)).length, 8, 'one subscription per LED');

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

test('QueryDimmerLevel answers on both the new and the legacy path, naming the zone', async () => {
  for (const url of ['/api/lutron/zone/query?id=101', '/api/zone/query?id=101']) {
    const { status, json } = await hub.get(url);
    assert.equal(status, 200, url);
    assert.deepEqual(json, { zone: '101', level: 75 }, url);
  }
  assert.equal((await hub.get('/api/zone/query?id=999')).status, 404);
  assert.equal((await hub.get('/api/zone/query')).status, 400);
});

test('feedback: Savant gets every level when it starts asking, then changes made anywhere', async () => {
  const levelsIn = (answer) => Object.fromEntries(Object.keys(answer)
    .filter((k) => k.startsWith('z'))
    .map((k) => [answer[k], answer[`l${k.slice(1)}`]]));
  const poll = async () => (await hub.get('/api/lutron/feedback')).json;

  const first = await poll();
  assert.deepEqual(Object.keys(levelsIn(first)).sort(), ['101', '102', '201', '202', '203', '301'], 'every zone but the thermostat');
  assert.equal(levelsIn(first)[101], 75);
  assert.ok('k0' in (await poll()), 'then the keypad LEDs');
  assert.deepEqual(await poll(), {});

  // A keypad dims the kitchen: the processor tells SplycedBoard, nobody asked for it
  mock.state.zones.find((z) => z.id === 101).level = 20;
  mock.push({ ZoneStatus: { Zone: { href: '/zone/101' }, Level: 20 } });
  const next = await h.waitFor(async () => { const a = await poll(); return Object.keys(a).length && a; }, { what: 'feedback' });
  assert.deepEqual(levelsIn(next), { 101: 20 });

  assert.deepEqual((await hub.get('/api/lutron/status')).json.feedbackFrom, ['127.0.0.1'], 'the dashboard sees Savant asking');
});

test('feedback: keypad LEDs follow the levels, keyed device_LED, and change when a button is pressed', async () => {
  const poll = async (query = '') => (await hub.get(`/api/lutron/feedback${query}`)).json;
  const ledsIn = (answer) => Object.fromEntries(Object.keys(answer).filter((k) => k.startsWith('k')).map((k) => [answer[k], answer[`o${k.slice(1)}`]]));

  // Savant starting: every level, then every LED
  const levels = await poll('?start=1');
  assert.ok('z0' in levels);
  const leds = ledsIn(await poll());
  assert.deepEqual(leds['501_806'], 1, 'All Off is lit');
  assert.equal(Object.keys(leds).length, 8, 'every LED of both keypads');
  assert.deepEqual(await poll(), {});

  // Night pressed at the keypad (here: from the dashboard): its LED comes on
  const night = (await hub.get('/api/lutron/inventory')).json.buttonGroups.find((g) => g.deviceId === 501).buttons.find((b) => b.number === 4);
  await hub.post('/api/lutron/button/press', { href: night.href });
  await hub.post('/api/lutron/button/release', { href: night.href });
  const next = await h.waitFor(async () => { const a = await poll(); return Object.keys(a).length && a; }, { what: 'LED feedback' });
  assert.deepEqual(ledsIn(next), { '501_804': 1 });
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

// Keypad Button rows as Blueprint itself writes them (a row made in Blueprint 11.2.4 with this
// profile's Keypad Button entity): the same keys, the LED as State1, five child actions.
const BLUEPRINT_KEYPAD_ROW_KEYS = ['Address1', 'Address2', 'Address3', 'Address4', 'Address5', 'Address6', 'BLEGroupId', 'BLENetworkKey', 'BLENodeId', 'Button Label', 'Command', 'Command Type', 'Controller', 'Controller Zone', 'DelayTime', 'DimmerLevel', 'Enabled', 'Entity', 'FadeTime', 'Identifier', 'IsSceneable', 'Label', 'LightsAreOn', 'Logical Component', 'RoomLightsControl', 'Savant Keypad', 'Savant Zone', 'SavantAppGrouping', 'ServiceID', 'State1', 'State2', 'Technology', 'Toggle Label', 'Type', 'UI Type', 'UITypeChild', 'UMF', 'WholeHouseLightsControl', 'hasCompiled', 'maxKelvinTemp', 'minKelvinTemp', 'sendReleaseAfterHold', 'shouldDefaultRow'];
const BLUEPRINT_KEYPAD_CHILD_KEYS = ['Address1', 'Address2', 'Address3', 'Address4', 'Address5', 'Address6', 'Button Label', 'Command', 'Command Type', 'Controller', 'Controller Zone', 'Enabled', 'Entity', 'Identifier', 'Label', 'LightsAreOn', 'Savant Keypad', 'Savant Zone', 'Technology', 'Type', 'UI Type', 'shouldDefaultRow'];

test('lighting export: keypad buttons only when asked, as Blueprint writes Keypad Button rows', async () => {
  const exported = async (query = '') => {
    const res = await fetch(`${hub.base}/api/lutron/export/lighting${query}`);
    return JSON.parse(require('child_process').execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: await res.text() }).toString()).Lighting;
  };
  assert.equal((await exported()).filter((r) => r.Entity === 'Keypad Button').length, 0, 'not unless asked');

  const rows = await exported('?keypads=1');
  const lights = rows.filter((r) => r.Entity !== 'Keypad Button');
  const keys = rows.filter((r) => r.Entity === 'Keypad Button');
  assert.equal(keys.length, 12, 'every button of both keypads, raise and lower too');
  assert.deepEqual(rows.map((r) => r.Identifier), rows.map((_, i) => String(i)), 'numbered on from the lights');
  assert.ok(lights.length && rows.indexOf(keys[0]) === lights.length, 'after the lights');

  const welcome = keys.find((r) => r.Label === 'Entry Welcome');
  assert.deepEqual(Object.keys(welcome).sort(), BLUEPRINT_KEYPAD_ROW_KEYS);
  assert.deepEqual([welcome.Address1, welcome.Address2, welcome.Address3], ['501', '1', '801']);
  assert.deepEqual([welcome.Command, welcome['Command Type'], welcome['UI Type'], welcome.SavantAppGrouping], ['ButtonPress', 'Push Command', 'Toggle', 'Scene']);
  const component = welcome.Controller;
  assert.equal(welcome.State1.RPMStateName, `${component}.Lighting_controller.IsCurrentLEDOn_501_801`, 'lit by profile 1.15\'s LED feedback');
  assert.deepEqual(welcome.State1.identifiers.map((i) => [i.name, i.value]), [['DeviceID', '501'], ['LEDNumber', '801']]);
  assert.deepEqual(welcome.State2, {});
  assert.deepEqual(welcome.UITypeChild.map((c) => [c.Command, c['Command Type']]), [
    ['ButtonPress', 'Toggle Command'], ['ButtonRelease', 'Release Command'], ['ButtonRelease', 'Toggle Release Command'],
    ['ButtonPressAndRelease', 'OSD Push Command'], ['ButtonPressAndRelease', 'OSD Hold Command'],
  ]);
  assert.deepEqual(Object.keys(welcome.UITypeChild[0]).sort(), BLUEPRINT_KEYPAD_CHILD_KEYS);

  // In faceplate order; raise and lower have no LED
  assert.deepEqual(keys.filter((r) => r.Address1 === '501').map((r) => r.Label), [
    'Entry Welcome', 'Entry Cooking', 'Entry Dinner', 'Entry Night', 'Entry All Off', 'Entry Lower', 'Entry Raise',
  ]);
  const raise = keys.find((r) => r.Label === 'Entry Raise');
  assert.deepEqual([raise.Address2, raise.Address3, raise.State1.RPMStateName.endsWith('IsCurrentLEDOn_501_0')], ['19', '', true]);
  assert.deepEqual(Object.keys(keys.find((r) => r.Label === 'Bedside Bright')['Savant Zone']), ['Primary Suite'], 'under its Lutron area until mapped');
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
