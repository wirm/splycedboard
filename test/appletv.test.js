/**
 * Apple TV integration end-to-end against three mock Apple TVs: PIN pairing, Savant
 * commands routed by IP, feedback, reconnects, persistence and on/off.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { startMockAppleTv } = require('./support/mock-appletv');

const HID = { Up: 1, Select: 6, Home: 7, Sleep: 12, Wake: 13, PlayPause: 14 };
const TVS = [
  { ip: '10.0.0.11', name: 'Living Room', pin: '1234' },
  { ip: '10.0.0.12', name: 'Primary Bedroom', pin: '5678' },
  { ip: '10.0.0.13', name: 'Gym', pin: '4321', answersAttention: false }, // newer tvOS behaviour
];

let hub;
const mocks = {};

const status = async (ip) => (await hub.get(`/api/appletv/status?ip=${ip}`)).json;
const devices = async () => (await hub.get('/api/appletv/devices')).json.devices;
const waitConnected = (ip) => h.waitFor(async () => (await status(ip)).connected === 'true', { timeout: 8000, what: `${ip} connected` });

async function pair(tv, pin = tv.pin) {
  const mock = mocks[tv.ip];
  const start = await hub.post('/api/appletv/pair/start', { ip: tv.ip, host: '127.0.0.1', port: mock.port, name: tv.name });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  return hub.post('/api/appletv/pair/finish', { ip: tv.ip, pin });
}

before(async () => {
  for (const tv of TVS) mocks[tv.ip] = await startMockAppleTv(tv);
  h.setEnabled({ lutron: false, scli: false, appletv: true });
  hub = await h.startHub();
});

after(async () => {
  await hub?.stop();
  for (const mock of Object.values(mocks)) await mock.close();
});

test('starts with no Apple TVs and says so', async () => {
  const { json } = await hub.get('/api/hub');
  const atv = json.integrations.find((i) => i.id === 'appletv');
  assert.equal(atv.running, true);
  assert.equal(atv.status.level, 'idle');
  assert.deepEqual(await devices(), []);
});

test('a wrong PIN is rejected; the right PIN pairs', async () => {
  const tv = TVS[0];
  const wrong = await pair(tv, '0000');
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /Wrong PIN/);

  const ok = await pair(tv);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.name, 'Living Room');
  assert.equal(ok.json.address, tv.ip);
  assert.equal(mocks[tv.ip].state.pinShown, 2, 'TV showed a PIN for each attempt');
  assert.deepEqual(mocks[tv.ip].state.pairedNames, ['SplycedBoard']);
  await waitConnected(tv.ip);
});

test('pairs several Apple TVs, each addressed by its own IP', async () => {
  for (const tv of TVS.slice(1)) {
    const res = await pair(tv);
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }
  for (const tv of TVS) await waitConnected(tv.ip);

  const list = await devices();
  assert.deepEqual(list.map((d) => d.address).sort(), TVS.map((t) => t.ip).sort());
  assert.ok(list.every((d) => !('credentials' in d)), 'credentials never leave the server');

  const { json } = await hub.get('/api/hub');
  assert.match(json.integrations.find((i) => i.id === 'appletv').status.text, /3 Apple TVs connected/);
});

test('the session is set up the way the iPhone Remote does it', () => {
  const ids = mocks[TVS[0].ip].state.requests.map((r) => r._i);
  const setup = ids.slice(ids.lastIndexOf('_systemInfo'));
  assert.deepEqual(setup.slice(0, 5), ['_systemInfo', '_touchStart', '_sessionStart', 'TVRCSessionStart', '_tiStart']);
  const info = mocks[TVS[0].ip].state.requests.find((r) => r._i === '_systemInfo')._c;
  assert.equal(info.name, 'SplycedBoard');
  assert.ok(Buffer.isBuffer(info._idsID));
});

test('Savant commands go only to the Apple TV at that IP', async () => {
  for (const mock of Object.values(mocks)) mock.clearLog();

  assert.equal((await hub.get(`/api/appletv/cmd?ip=${TVS[1].ip}&cmd=OSDCursorUp`)).status, 200);
  assert.deepEqual(mocks[TVS[1].ip].state.hid, [[HID.Up, 1], [HID.Up, 2]]);
  assert.deepEqual(mocks[TVS[0].ip].state.hid, []);
  assert.deepEqual(mocks[TVS[2].ip].state.hid, []);

  await hub.get(`/api/appletv/cmd?ip=${TVS[0].ip}&cmd=home&action=double`);
  assert.deepEqual(mocks[TVS[0].ip].state.hid, [[HID.Home, 1], [HID.Home, 2], [HID.Home, 1], [HID.Home, 2]]);

  assert.equal((await hub.get(`/api/appletv/cmd?ip=10.9.9.9&cmd=up`)).status, 404);
  assert.equal((await hub.get(`/api/appletv/cmd?ip=${TVS[0].ip}&cmd=explode`)).status, 400);
  assert.equal((await hub.get(`/api/appletv/cmd?cmd=up`)).status, 400);
});

test('play/pause use media commands and report playing state', async () => {
  const ip = TVS[0].ip;
  mocks[ip].clearLog();
  await hub.get(`/api/appletv/cmd?ip=${ip}&cmd=CommandPlay`);
  assert.deepEqual(mocks[ip].state.mcc, [1]);
  await h.waitFor(async () => (await status(ip)).playing === 'true', { what: 'playing' });

  await hub.get(`/api/appletv/cmd?ip=${ip}&cmd=CommandPlay`); // already playing: nothing sent
  assert.deepEqual(mocks[ip].state.mcc, [1]);

  await hub.get(`/api/appletv/cmd?ip=${ip}&cmd=CommandPause`);
  assert.deepEqual(mocks[ip].state.mcc, [1, 2]);
  await h.waitFor(async () => (await status(ip)).playing === 'false', { what: 'paused' });
});

test('power off/on, with state pushed back from the Apple TV', async () => {
  const ip = TVS[1].ip;
  assert.equal((await status(ip)).power, 'ON');
  await hub.get(`/api/appletv/cmd?ip=${ip}&cmd=PowerOff`);
  assert.deepEqual(mocks[ip].state.hid.at(-1), [HID.Sleep, 2]);
  await h.waitFor(async () => (await status(ip)).power === 'OFF', { what: 'off' });

  await hub.get(`/api/appletv/cmd?ip=${ip}&cmd=PowerOn`);
  assert.deepEqual(mocks[ip].state.hid.at(-1), [HID.Wake, 2]);
  await h.waitFor(async () => (await status(ip)).power === 'ON', { what: 'on' });
});

test('power state still works on tvOS that no longer answers FetchAttentionState', async () => {
  const ip = TVS[2].ip;
  assert.equal((await status(ip)).power, 'UNKNOWN');
  mocks[ip].setAttention(1);
  await h.waitFor(async () => (await status(ip)).power === 'OFF', { what: 'event-driven power state' });
});

test('app list and launching', async () => {
  const ip = TVS[0].ip;
  const { json: apps } = await hub.get(`/api/appletv/apps?ip=${ip}`);
  assert.deepEqual(apps.map((a) => a.name), ['Netflix', 'TV']);
  await hub.get(`/api/appletv/app?ip=${ip}&id=com.netflix.Netflix`);
  assert.deepEqual(mocks[ip].state.launched, ['com.netflix.Netflix']);
});

/** Every action in the Savant profile, as the URL Savant would request. */
function profileRequests(ip) {
  const xml = require('fs').readFileSync(path.join(__dirname, '..', 'SplycedBoard', 'profiles', 'apple_apple tv (splycedboard).xml'), 'utf8');
  const out = [];
  for (const [, name, body] of xml.matchAll(/<action name="([^"]+)">([\s\S]*?)<\/action>/g)) {
    const command = body.match(/<command_string type="character"[^>]*>([^<]+)<\/command_string>/)[1];
    const params = [...body.matchAll(/<parameter parameter_data_type="character"(?: (state_variable|action_argument)="([^"]+)")?\s*(?:\/>|><!\[CDATA\[(.*?)\]\]><\/parameter>)/g)]
      .map(([, kind, ref, text]) => {
        if (kind === 'state_variable') return ref === 'AppleTVAddress' ? ip : '';
        if (kind === 'action_argument') return { AppID: 'com.netflix.Netflix', PIN: '1234' }[ref];
        return text;
      });
    out.push({ name, url: `/${command}${params.join('')}` });
  }
  return out;
}

test('every action in the Savant profile is accepted by SplycedBoard', async () => {
  const requests = profileRequests(TVS[0].ip).filter((r) => !r.name.startsWith('Pair'));
  assert.equal(requests.length, 29);
  for (const { name, url } of requests) {
    const res = await hub.get(url);
    assert.equal(res.status, 200, `${name} → ${url}: ${res.text}`);
  }
  const statusAction = requests.find((r) => r.name === 'QueryStatus');
  assert.deepEqual(Object.keys((await hub.get(statusAction.url)).json).sort(), ['connected', 'name', 'playing', 'power', 'state']);

  // ReportProfileVersion: SplycedBoard now knows this Apple TV's component runs the shipped profile.
  const report = requests.find((r) => r.name === 'ReportProfileVersion');
  assert.equal((await hub.get(report.url)).json.state, 'current');
  const { profileStatus } = (await hub.get('/api/hub')).json.integrations.find((i) => i.id === 'appletv');
  assert.deepEqual(profileStatus.sources.map((s) => [s.device, s.state]), [[TVS[0].ip, 'current']]);
  assert.equal(profileStatus.warning, null);
});

test('a command after the Apple TV dropped the connection reconnects and still goes through', async () => {
  const ip = TVS[0].ip;
  mocks[ip].dropConnections();
  mocks[ip].clearLog();
  const res = await hub.get(`/api/appletv/cmd?ip=${ip}&cmd=select`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(mocks[ip].state.hid, [[HID.Select, 1], [HID.Select, 2]]);
});

test('a pairing removed on the Apple TV is reported, and re-pairing fixes it', async () => {
  const tv = TVS[1];
  mocks[tv.ip].forgetPairings();
  mocks[tv.ip].dropConnections();
  const res = await hub.get(`/api/appletv/cmd?ip=${tv.ip}&cmd=up`);
  assert.equal(res.status, 502);
  assert.match(res.json.error, /no longer accepts this pairing/);

  const list = await devices();
  const before = list.find((d) => d.address === tv.ip);
  assert.equal((await pair(tv)).status, 200);
  await waitConnected(tv.ip);
  const after = (await devices()).find((d) => d.address === tv.ip);
  assert.equal(after.id, before.id, 're-pairing keeps the same device');
});

test('rename and remove from the dashboard', async () => {
  const [gym] = (await devices()).filter((d) => d.name === 'Gym');
  const renamed = await hub.put(`/api/appletv/devices/${gym.id}`, {}); // PUT isn't a route
  assert.equal(renamed.status, 404);
  const patch = await fetch(`${hub.base}/api/appletv/devices/${gym.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Home Gym' }),
  });
  assert.equal((await patch.json()).name, 'Home Gym');
  const clash = await fetch(`${hub.base}/api/appletv/devices/${gym.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: TVS[0].ip }),
  });
  assert.equal(clash.status, 409);

  const del = await fetch(`${hub.base}/api/appletv/devices/${gym.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await hub.get(`/api/appletv/status?ip=${TVS[2].ip}`)).status, 404);
  await h.waitFor(() => mocks[TVS[2].ip].connections === 0, { what: 'removed TV disconnected' });
});

test('pairings survive a restart without re-pairing', async () => {
  const saved = h.readJson(path.join(h.DATA_DIR, 'appletv', 'settings.json'));
  assert.equal(saved.devices.length, 2);
  assert.ok(saved.devices.every((d) => d.credentials?.atvPublic && d.credentials?.clientSecret));
  const identity = saved.identity;

  await hub.stop();
  hub = await h.startHub();
  for (const tv of TVS.slice(0, 2)) await waitConnected(tv.ip);
  assert.deepEqual(h.readJson(path.join(h.DATA_DIR, 'appletv', 'settings.json')).identity, identity, 'same identity');
});

test('switching Apple TV off disconnects everything; on reconnects', async () => {
  await hub.put('/api/hub/integrations/appletv', { enabled: false });
  assert.equal((await hub.get(`/api/appletv/status?ip=${TVS[0].ip}`)).status, 503);
  await h.waitFor(() => mocks[TVS[0].ip].connections === 0 && mocks[TVS[1].ip].connections === 0, { what: 'disconnected' });

  await hub.put('/api/hub/integrations/appletv', { enabled: true });
  for (const tv of TVS.slice(0, 2)) await waitConnected(tv.ip);
});
