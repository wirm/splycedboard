/**
 * The TV tools (Tools → Samsung TV, LG TV, Sony TV) through the hub's API, against mock TVs:
 * every Samsung generation (IP Control's AccessToken, Smart View pairing, the legacy remote),
 * LG's encrypted IP control with a keycode, Sony's Pre-Shared Key; scanning; and the TVs in
 * the Blueprint configuration Savant runs, with the keys Blueprint has for them.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const mocks = require('./support/mock-tvs');
const lan = require('../SplycedBoard/src/core/lan');
const samsungIp = require('../SplycedBoard/src/integrations/samsungtv/ipcontrol');
const samsungSv = require('../SplycedBoard/src/integrations/samsungtv/smartview');
const samsungLegacy = require('../SplycedBoard/src/integrations/samsungtv/legacy');
const lgIp = require('../SplycedBoard/src/integrations/lgtv/ipcontrol');
const bravia = require('../SplycedBoard/src/integrations/sonytv/bravia');

const TV = '127.0.0.1';
let hub;
let closedPort; // nothing listens here: a protocol the TV under test doesn't have

// The configuration Savant runs (userConfig.rpmConfig), as far as the TV tools read it.
const CONFIG = process.env.SPLYCEDBOARD_SAVANT_CONFIG;

function plist(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
  execFileSync('plutil', ['-convert', 'xml1', file]);
}

const profile = (manufacturer, model, body) => `<?xml version="1.0" encoding="UTF-8"?>
<component xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" manufacturer="${manufacturer}" model="${model}" device_class="HD_monitor" rpm_xml_version="1.0">
  ${body}
</component>
`;

function savantRuns({ samsungToken = '', livingRoomAddress = '192.0.2.10' } = {}) {
  fs.rmSync(CONFIG, { recursive: true, force: true });
  fs.mkdirSync(path.join(CONFIG, 'componentProfiles'), { recursive: true });
  const rows = [
    ['Network Switch', 'Shared Equipment', 'NetworkSwitch Large', 'Generic', 'Network_device'],
    ['Living Room TV', 'Living Room', 'TV (2025)', 'Samsung', 'HD_monitor'],
    ['Kitchen TV', 'Kitchen', 'QN(XX)Q60T', 'Samsung', 'HD_monitor'],
    ['Den Blu-ray', 'Den', 'BD-C5500', 'Samsung', 'EnhancedDVD_player'],
    ['Bedroom TV', 'Bedroom', 'OLED(XX)CXPUB', 'LG', 'HD_monitor'],
    ['Den TV', 'Den', 'K-(xx)XR90', 'Sony', 'HD_monitor'],
    ['Den Projector', 'Den', 'VPL-VW695ES', 'Sony', 'HD_monitor'],
  ];
  const sql = [
    'CREATE TABLE ZoneConfigComponents (id INTEGER PRIMARY KEY, component TEXT, zone TEXT, model TEXT, manufacturer TEXT, componentType INTEGER, componentID TEXT, uid TEXT, zoneType INTEGER, deviceType TEXT);',
    ...rows.map(([c, z, m, man, t], i) => `INSERT INTO ZoneConfigComponents VALUES (${i + 1}, '${c}', '${z}', '${m}', '${man}', 6, 'id${i}', '', 2, '${t}');`),
  ].join('\n');
  execFileSync('sqlite3', [path.join(CONFIG, 'serviceImplementation.sqlite')], { input: sql });
  // Cables from the switch (source) to each TV (sink), with Blueprint's IP and MAC fields.
  const cable = (sink, address, mac) => ({
    RPMComponentConnectionHostAddress: address,
    ...(mac ? { RPMComponentConnectionMacAddress: mac } : {}),
    RPMComponentConnectionSourceInfo: { RPMComponentIdentifier: 'Network Switch', RPMComponentConnectorIdentifier: 'Port 1' },
    RPMComponentConnectionSinkInfo: { RPMComponentIdentifier: sink, RPMComponentConnectorIdentifier: 'LAN' },
  });
  plist(path.join(CONFIG, 'componentConnections.plist'), [
    cable('Living Room TV', livingRoomAddress, '8C:79:F5:00:00:01'),
    cable('Bedroom TV', '192.0.2.11'),
    cable('Den TV', '192.0.2.12'),
    cable('Den Projector', '192.0.2.13'),
    cable('Den Blu-ray', '192.0.2.14'),
  ]);
  plist(path.join(CONFIG, 'componentStateVariables.plist'), {
    'Living Room TV': { InitialValues: samsungToken ? { AccessToken: samsungToken } : {}, MinValues: {}, MaxValues: {} },
    'Bedroom TV': { InitialValues: { AccessToken: 'ABCD1234' }, MinValues: {}, MaxValues: {} },
  });
  const dir = path.join(CONFIG, 'componentProfiles');
  fs.writeFileSync(path.join(dir, 'samsung_tv (2025).xml'), profile('Samsung', 'TV (2025)', '<state_variable name="AccessToken" user_editable="yes"/>'));
  fs.writeFileSync(path.join(dir, 'samsung_qn(xx)q60t.xml'), profile('Samsung', 'QN(XX)Q60T', '<state_variable name="AccessToken" user_editable="yes"/>'));
  fs.writeFileSync(path.join(dir, 'lg_oled(xx)cxpub.xml'), profile('LG', 'OLED(XX)CXPUB', '<state_variable name="AccessToken" user_editable="yes"/>'));
  fs.writeFileSync(path.join(dir, 'sony_k-(xx)xr90.xml'), profile('Sony', 'K-(xx)XR90', '<http_header name="X-Auth-PSK">1234</http_header>'));
}

async function waitJob(tool, job) {
  return h.waitFor(async () => {
    const j = (await hub.get(`/api/${tool}/jobs/${job.id}`)).json;
    return j.state !== 'running' ? j : null;
  }, { timeout: 15000, what: `${tool} ${job.kind}` });
}

async function addTv(tool, body = { address: TV }) {
  const res = await hub.post(`/api/${tool}/tvs`, body);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

async function removeAll(tool) {
  const { tvs } = (await hub.get(`/api/${tool}/tvs`)).json;
  for (const tv of tvs) if (!tv.blueprint) await fetch(`${hub.base}/api/${tool}/tvs/${tv.id}`, { method: 'DELETE' });
}

const command = (tool, tv, cmd, value) => hub.post(`/api/${tool}/tvs/${tv.id}/command`, { command: cmd, value });

before(async () => {
  lan.timing.probeSsdpMs = 150;
  closedPort = await h.freePort();
  for (const ports of [samsungIp.PORTS, samsungSv.PORTS, samsungLegacy.PORTS, lgIp.PORTS, bravia.PORTS]) {
    for (const k of Object.keys(ports)) ports[k] = closedPort;
  }
  h.setEnabled({ lutron: false, scli: false, appletv: false });
  hub = await h.startHub();
});

after(async () => {
  await hub?.stop();
});

test('the three tools are listed as tools, and start with no TVs', async () => {
  const { integrations } = (await hub.get('/api/hub')).json;
  const tools = integrations.filter((i) => i.category === 'tool');
  assert.deepEqual(tools.map((t) => [t.id, t.name]), [['samsungtv', 'Samsung TV'], ['lgtv', 'LG TV'], ['sonytv', 'Sony TV']]);
  for (const t of tools) {
    assert.equal(t.running, true);
    assert.deepEqual(t.status, { level: 'idle', text: 'No TVs yet' });
  }
  const res = await hub.get('/api/samsungtv/tvs');
  assert.deepEqual(res.json, { tvs: [], blueprint: { found: false, withoutAddress: [] } });
});

test('Samsung 2020+: IP Control hands out the AccessToken after Allow, and the remote uses it', async () => {
  const info = await mocks.samsungInfo({ model: '20_NIKEM_UHD', modelName: 'QN65Q60TAFXZA', name: '[TV] Family Room', frame: false, powerState: 'on' });
  const ip = await mocks.samsungIpControl({ token: 'TOKEN-2020' });
  samsungSv.PORTS.api = info.port;
  samsungIp.PORTS.ipControl = ip.port;
  try {
    const tv = await addTv('samsungtv');
    assert.equal(tv.name, 'Family Room');
    assert.equal(tv.model, 'QN65Q60TAFXZA');
    assert.equal(tv.year, 2020);
    assert.equal(tv.mac, '70:2A:D5:B9:18:FE');
    assert.equal(tv.info.ipControl, true);
    assert.deepEqual(tv.commands, ['power_on'], 'nothing but Wake-on-LAN before pairing');

    // Someone picks Allow on the TV
    const job = (await hub.post(`/api/samsungtv/tvs/${tv.id}/pair`)).json;
    assert.equal(job.state, 'running');
    const done = await waitJob('samsungtv', job);
    assert.equal(done.state, 'done', done.message);
    assert.equal(done.key, 'TOKEN-2020');
    assert.match(done.message, /AccessToken/);

    const paired = (await hub.get('/api/samsungtv/tvs')).json.tvs[0];
    assert.equal(paired.key, 'TOKEN-2020');
    assert.equal(paired.keyCheck.ok, true);
    assert.ok(paired.commands.includes('hdmi2') && paired.commands.includes('set_volume'));

    // The remote, over IP Control
    assert.equal((await command('samsungtv', tv, 'vol_up')).status, 200);
    assert.equal(ip.state.volume, 13);
    await command('samsungtv', tv, 'mute_toggle');
    assert.equal(ip.state.mute, 'muteOn');
    await command('samsungtv', tv, 'set_volume', 25);
    assert.equal(ip.state.volume, 25);
    await command('samsungtv', tv, 'hdmi2');
    assert.equal(ip.state.input, 'HDMI2');
    const up = ip.calls.findLast((c) => c.method === 'remoteKeyControl') || null;
    assert.equal(up, null);
    await command('samsungtv', tv, 'up');
    assert.deepEqual(ip.calls.at(-1), { id: 1, method: 'remoteKeyControl', jsonrpc: '2.0', params: { AccessToken: 'TOKEN-2020', remoteKey: 'cursorUp' } });
    assert.deepEqual((await hub.get(`/api/samsungtv/tvs/${tv.id}/state`)).json, { power: 'on', volume: 25, mute: true });
    await command('samsungtv', tv, 'power_off');
    assert.equal(ip.state.power, 'powerOff');
    assert.equal((await command('samsungtv', tv, 'input')).status, 400, 'IP Control has no source key');

    // A token the TV turns down is flagged
    ip.token = 'NEW-TOKEN';
    const checked = (await hub.post(`/api/samsungtv/tvs/${tv.id}/check`)).json;
    assert.equal(checked.keyCheck.ok, false);
    assert.match(checked.warnings.join(' '), /turned down the AccessToken/);

    // Deny on the TV
    ip.allow = false;
    const denied = await waitJob('samsungtv', (await hub.post(`/api/samsungtv/tvs/${tv.id}/pair`)).json);
    assert.equal(denied.state, 'failed');
    assert.match(denied.message, /Deny/);
  } finally {
    await removeAll('samsungtv');
    samsungSv.PORTS.api = closedPort;
    samsungIp.PORTS.ipControl = closedPort;
    await info.close();
    await ip.close();
  }
});

test('Samsung 2020+ with IP Remote off: warns, and pairs SplycedBoard\'s remote over Smart View instead', async () => {
  const info = await mocks.samsungInfo({ model: '21_PONTUSM_QTV', modelName: 'QN65QN90AAFXZA', frame: false });
  const sv = await mocks.samsungSmartView({ token: 'SV-2021' });
  samsungSv.PORTS.api = info.port;
  samsungSv.PORTS.secure = sv.port;
  try {
    const tv = await addTv('samsungtv');
    assert.equal(tv.year, 2021);
    assert.match(tv.warnings.join(' '), /IP Remote is off/);
    const done = await waitJob('samsungtv', (await hub.post(`/api/samsungtv/tvs/${tv.id}/pair`)).json);
    assert.equal(done.state, 'done', done.message);
    assert.match(done.message, /turn on IP Remote/);
    const paired = (await hub.get('/api/samsungtv/tvs')).json.tvs[0];
    assert.equal(paired.key, null, 'no AccessToken for Savant from Smart View');
    assert.equal(paired.extra.smartViewToken, 'SV-2021');
  } finally {
    await removeAll('samsungtv');
    samsungSv.PORTS.api = closedPort;
    samsungSv.PORTS.secure = closedPort;
    await info.close();
    await sv.close();
  }
});

test('Samsung 2016–2019 with IP Remote on: the AccessToken comes from port 1515, and the remote uses it there', async () => {
  const info = await mocks.samsungInfo(); // 2018 Frame, UN55LS03N
  const ip = await mocks.samsungIpControl({ token: 'TOKEN-2018' });
  samsungSv.PORTS.api = info.port;
  samsungIp.PORTS.ipControl2016 = ip.port; // 1515 on a real TV; 1516 stays closed
  try {
    const tv = await addTv('samsungtv');
    assert.equal(tv.year, 2018);
    assert.equal(tv.info.ipControl, true);
    assert.equal(tv.info.ipControlPort, ip.port);
    const done = await waitJob('samsungtv', (await hub.post(`/api/samsungtv/tvs/${tv.id}/pair`)).json);
    assert.equal(done.state, 'done', done.message);
    assert.equal(done.key, 'TOKEN-2018', 'Savant\'s AccessToken, not a Smart View token');
    const paired = (await hub.get('/api/samsungtv/tvs')).json.tvs[0];
    assert.equal(paired.key, 'TOKEN-2018');
    assert.equal(paired.extra.smartViewToken, undefined);
    await command('samsungtv', tv, 'vol_up');
    await command('samsungtv', tv, 'hdmi3');
    assert.deepEqual([ip.state.volume, ip.state.input], [13, 'HDMI3']);
    assert.ok(ip.calls.every((c) => c.method === 'createAccessToken' || c.params.AccessToken === 'TOKEN-2018'));
  } finally {
    await removeAll('samsungtv');
    samsungSv.PORTS.api = closedPort;
    samsungIp.PORTS.ipControl2016 = closedPort;
    await info.close();
    await ip.close();
  }
});

test('Samsung 2016–2019 with IP Remote off: Smart View pairing on Allow, then key presses with the token', async () => {
  const info = await mocks.samsungInfo(); // 2018 Frame, UN55LS03N
  const sv = await mocks.samsungSmartView({ token: 'SV-5678' });
  samsungSv.PORTS.api = info.port;
  samsungSv.PORTS.secure = sv.port;
  try {
    const tv = await addTv('samsungtv');
    assert.equal(tv.year, 2018);
    assert.equal(tv.info.frame, true);
    assert.deepEqual(tv.warnings, [], 'a 2018 TV has no IP Remote to turn on');

    const done = await waitJob('samsungtv', (await hub.post(`/api/samsungtv/tvs/${tv.id}/pair`)).json);
    assert.equal(done.state, 'done', done.message);
    assert.match(done.message, /isn't one Savant uses/);
    assert.match(done.message, /turn on IP Remote \(Settings → General → Network → Expert Settings\)/, '2016–2019 menu');
    assert.equal(sv.connections[0].searchParams.get('name'), Buffer.from('SplycedBoard').toString('base64'));
    assert.equal(sv.connections[0].searchParams.get('token'), null, 'asks without a token the first time');

    const paired = (await hub.get('/api/samsungtv/tvs')).json.tvs[0];
    assert.ok(paired.commands.includes('input') && paired.commands.includes('ok'));
    for (const cmd of ['up', 'ok', 'vol_up', 'input']) assert.equal((await command('samsungtv', tv, cmd)).status, 200);
    await h.waitFor(() => sv.keys.length === 4, { what: 'four keys' });
    assert.deepEqual(sv.keys, ['Click:KEY_UP', 'Click:KEY_ENTER', 'Click:KEY_VOLUP', 'Click:KEY_SOURCE']);
    assert.equal(sv.connections.at(-1).searchParams.get('token'), 'SV-5678', 'the remote connects with the token');
    assert.equal(sv.connections.length, 2, 'one pairing connection, then one kept open for the keys');
    assert.equal((await hub.get(`/api/samsungtv/tvs/${tv.id}/state`)).json.power, 'on');
  } finally {
    await removeAll('samsungtv');
    samsungSv.PORTS.api = closedPort;
    samsungSv.PORTS.secure = closedPort;
    await info.close();
    await sv.close();
  }
});

test('Samsung before 2016: the legacy remote asks once, then takes keys', async () => {
  const tvMock = await mocks.samsungLegacy();
  samsungLegacy.PORTS.legacy = tvMock.port;
  try {
    const tv = await addTv('samsungtv', { address: TV, name: 'Old Den TV' });
    assert.equal(tv.name, 'Old Den TV');
    assert.equal(tv.info.legacy, true);
    const done = await waitJob('samsungtv', (await hub.post(`/api/samsungtv/tvs/${tv.id}/pair`)).json);
    assert.equal(done.state, 'done', done.message);
    assert.equal(tvMock.remotes[0][2], 'SplycedBoard', 'the TV is asked about "SplycedBoard"');
    assert.equal((await command('samsungtv', tv, 'vol_down')).status, 200);
    assert.equal((await command('samsungtv', tv, 'power_off')).status, 200);
    assert.deepEqual(tvMock.keys, ['KEY_VOLDOWN', 'KEY_POWEROFF']);

    tvMock.allow = false;
    const denied = await waitJob('samsungtv', (await hub.post(`/api/samsungtv/tvs/${tv.id}/pair`)).json);
    assert.equal(denied.state, 'failed');
    assert.match(denied.message, /turned SplycedBoard down/);
  } finally {
    await removeAll('samsungtv');
    samsungLegacy.PORTS.legacy = closedPort;
    await tvMock.close();
  }
});

test('LG: the keycode is checked with the TV, and the remote is encrypted with it', async () => {
  const tvMock = await mocks.lg({ keycode: 'A1B2C3D4' });
  lgIp.PORTS.ipControl = tvMock.port;
  try {
    const tv = await addTv('lgtv', { address: TV, name: 'Bedroom' });
    assert.equal(tv.info.ipControl, true);
    assert.equal((await hub.put(`/api/lgtv/tvs/${tv.id}`, { key: 'abc' })).status, 400, 'a keycode is 8 letters and digits');

    const wrong = (await hub.put(`/api/lgtv/tvs/${tv.id}`, { key: 'ZZZZ9999' })).json;
    assert.equal(wrong.keyCheck.ok, false);
    assert.match(wrong.warnings.join(' '), /didn't accept keycode ZZZZ9999/);

    const right = (await hub.put(`/api/lgtv/tvs/${tv.id}`, { key: 'A1B2C3D4' })).json;
    assert.equal(right.keyCheck.ok, true);
    assert.equal(right.mac, 'A8:23:FE:01:02:03', 'the MAC the TV reports with the right keycode');
    assert.ok(right.commands.includes('power_on'), 'Wake-on-LAN now that there is a MAC');

    for (const [cmd, value] of [['vol_up'], ['ok'], ['home'], ['hdmi3'], ['set_volume', 30], ['mute_on']]) {
      const res = await command('lgtv', tv, cmd, value);
      assert.equal(res.status, 200, `${cmd}: ${res.text}`);
    }
    assert.deepEqual(tvMock.commands.slice(-6), ['KEY_ACTION volumeup', 'KEY_ACTION ok', 'KEY_ACTION myapp', 'INPUT_SELECT hdmi3', 'VOLUME_CONTROL 30', 'VOLUME_MUTE on']);
    assert.deepEqual((await hub.get(`/api/lgtv/tvs/${tv.id}/state`)).json, { power: 'on', volume: 30, mute: true, source: 'com.webos.app.hdmi1' });
    await command('lgtv', tv, 'power_off');
    assert.equal(tvMock.commands.at(-1), 'POWER off');
  } finally {
    await removeAll('lgtv');
    lgIp.PORTS.ipControl = closedPort;
    await tvMock.close();
  }
});

test('Sony: starts with Savant\'s 1234, checks it, and the remote uses the TV\'s own IRCC codes', async () => {
  const tvMock = await mocks.sony({ psk: '1234' });
  bravia.PORTS.http = tvMock.port;
  try {
    const tv = await addTv('sonytv');
    assert.equal(tv.name, 'BRAVIA XR-65A80J');
    assert.equal(tv.year, 2021);
    assert.equal(tv.key, '1234');
    assert.equal(tv.keyCheck.ok, true);
    assert.equal(tv.mac, '04:5D:4B:AA:BB:CC');

    await command('sonytv', tv, 'vol_up');
    await command('sonytv', tv, 'hdmi2');
    assert.deepEqual(tvMock.ircc, ['TV-VOLUP', 'AAAAAgAAABoAAABbAw=='], 'the TV\'s code where it lists one, else Savant\'s');
    await command('sonytv', tv, 'set_volume', 22);
    await command('sonytv', tv, 'mute_on');
    assert.deepEqual((await hub.get(`/api/sonytv/tvs/${tv.id}/state`)).json, { power: 'on', volume: 22, mute: true, source: 'HDMI 2' });
    await command('sonytv', tv, 'power_off');
    assert.equal(tvMock.state.power, 'standby');

    const wrong = (await hub.put(`/api/sonytv/tvs/${tv.id}`, { key: '9999' })).json;
    assert.equal(wrong.keyCheck.ok, false);
    assert.match(wrong.warnings.join(' '), /turned down Pre-Shared Key "9999"/);
    assert.equal((await command('sonytv', tv, 'vol_down')).status, 403);
  } finally {
    await removeAll('sonytv');
    bravia.PORTS.http = closedPort;
    await tvMock.close();
  }
});

test('scanning finds the brand\'s TVs among the devices that answer', async () => {
  const info = await mocks.samsungInfo();
  samsungSv.PORTS.api = info.port;
  const realSweep = lan.sweep;
  const realSsdp = lan.ssdp;
  lan.sweep = async () => new Map([[TV, { ports: [8001], mac: '70:2A:D5:B9:18:FE' }]]);
  lan.ssdp = async () => new Map();
  try {
    const job = (await hub.post('/api/samsungtv/scan')).json;
    const done = await waitJob('samsungtv', job);
    assert.equal(done.state, 'done');
    assert.equal(done.message, 'Found 1 Samsung TV');
    assert.equal(done.found.length, 1);
    assert.deepEqual(
      [done.found[0].address, done.found[0].name, done.found[0].model, done.found[0].year, done.found[0].mac, done.found[0].known],
      [TV, 'Living Room', 'UN55LS03N', 2018, '70:2A:D5:B9:18:FE', null],
    );
    // Nothing that's an LG
    const lgScan = await waitJob('lgtv', (await hub.post('/api/lgtv/scan')).json);
    assert.equal(lgScan.state, 'done');
    assert.equal(lgScan.found.length, 0);
    assert.ok(lgScan.hint || lgScan.problem, 'says why a scan can come back empty');
  } finally {
    lan.sweep = realSweep;
    lan.ssdp = realSsdp;
    samsungSv.PORTS.api = closedPort;
    await info.close();
  }
});

test('TVs in the Blueprint configuration are listed with Blueprint\'s key, and a missing one is flagged', async () => {
  savantRuns();
  try {
    const samsung = (await hub.get('/api/samsungtv/tvs')).json;
    assert.equal(samsung.blueprint.found, true);
    assert.deepEqual(samsung.tvs.map((t) => [t.name, t.address, t.mac]), [['Living Room TV', '192.0.2.10', '8C:79:F5:00:00:01']]);
    const living = samsung.tvs[0];
    assert.deepEqual(living.blueprint, {
      component: 'Living Room TV', zone: 'Living Room', manufacturer: 'Samsung', model: 'TV (2025)', keyVariable: 'AccessToken', key: null,
    });
    assert.match(living.warnings.join(' '), /No AccessToken is stored for "Living Room TV" in Blueprint/);
    assert.deepEqual(samsung.blueprint.withoutAddress, [{ component: 'Kitchen TV', zone: 'Kitchen', model: 'QN(XX)Q60T' }], 'no IP: IR or RS-232');
    assert.equal((await fetch(`${hub.base}/api/samsungtv/tvs/${living.id}`, { method: 'DELETE' })).status, 409, 'Blueprint\'s TVs stay');

    const samsungStatus = (await hub.get('/api/hub')).json.integrations.find((i) => i.id === 'samsungtv').status;
    assert.deepEqual(samsungStatus, { level: 'warn', text: '1 TV · 1 needs attention' });

    const lg = (await hub.get('/api/lgtv/tvs')).json;
    assert.deepEqual(lg.tvs.map((t) => [t.name, t.key, t.warnings]), [['Bedroom TV', 'ABCD1234', []]]);

    const sony = (await hub.get('/api/sonytv/tvs')).json;
    assert.deepEqual(sony.tvs.map((t) => [t.name, t.key, t.blueprint.key]), [['Den TV', '1234', '1234']], 'the key in its profile; projectors aren\'t TVs');

    // A new upload with the token in it: taken on the next look, and the warning goes.
    await new Promise((r) => setTimeout(r, 20));
    savantRuns({ samsungToken: 'BP-TOKEN' });
    const after = (await hub.get('/api/samsungtv/tvs')).json.tvs[0];
    assert.equal(after.id, living.id);
    assert.equal(after.key, 'BP-TOKEN');
    assert.deepEqual(after.warnings, []);

    // A different token here than in Blueprint: Savant uses Blueprint's
    const changed = (await hub.put(`/api/samsungtv/tvs/${living.id}`, { key: 'OTHER' })).json;
    assert.match(changed.warnings.join(' '), /Blueprint has a different AccessToken/);

    // Someone pastes a new token into Blueprint and moves the TV: both are taken.
    await new Promise((r) => setTimeout(r, 20));
    savantRuns({ samsungToken: 'BP-TOKEN-2', livingRoomAddress: '192.0.2.20' });
    const moved = (await hub.get('/api/samsungtv/tvs')).json.tvs[0];
    assert.deepEqual([moved.id, moved.address, moved.key, moved.warnings], [living.id, '192.0.2.20', 'BP-TOKEN-2', []]);
    const saved = h.readJson(path.join(h.DATA_DIR, 'samsungtv', 'settings.json')).tvs[0];
    assert.deepEqual([saved.address, saved.key], ['192.0.2.20', 'BP-TOKEN-2'], 'and kept');
  } finally {
    fs.rmSync(CONFIG, { recursive: true, force: true });
    await hub.post('/api/samsungtv/blueprint');
  }
});
