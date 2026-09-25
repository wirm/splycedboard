/**
 * SCLI bridge against a fake sclibridge script that echoes its arguments.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { parseServiceRequestArgs } = require('../SplycedBoard/src/integrations/scli/sclibridge');

let hub;
let clientPort;
let savantPort;

before(async () => {
  const fake = path.join(h.HOME, 'sclibridge');
  // One argument per line, so tests can see exactly how the command was split.
  fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n', { mode: 0o755 });
  clientPort = await h.freePort();
  savantPort = await h.freePort();
  h.patchSettings('scli', { sclibridgePath: fake, clientPort, savantPort });
  h.setEnabled({ lutron: false, scli: true });
  hub = await h.startHub();
});

after(async () => {
  await hub?.stop();
});

test('raw TCP command runs through sclibridge', async () => {
  const out = await h.rawExchange(clientPort, 'readstate userDefined.vacation_mode_status\n');
  assert.equal(out, '[readstate]\n[userDefined.vacation_mode_status]\n');
});

test('HTTP GET command returns a plain-text response', async () => {
  const res = await fetch(`http://127.0.0.1:${clientPort}/writestate%20userDefined.foo%201`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '[writestate]\n[userDefined.foo]\n[1]\n');
});

test('quoted arguments stay together and lose their quotes, as in a shell', async () => {
  let out = await h.rawExchange(clientPort, 'readstate "Lighting Controller.Lighting_controller.DimmerLevel_486"\n');
  assert.equal(out, '[readstate]\n[Lighting Controller.Lighting_controller.DimmerLevel_486]\n');
  out = await (await fetch(`http://127.0.0.1:${clientPort}/writestate%20%22userDefined.Guest%20Mode%22%20'on%20hold'`)).text();
  assert.equal(out, '[writestate]\n[userDefined.Guest Mode]\n[on hold]\n');
});

test('servicerequestcommand arguments are split into name/value pairs', async () => {
  assert.deepEqual(
    parseServiceRequestArgs('servicerequestcommand Den-AppleTV-1-SVC_AV_TV-PowerOn:Level=50,Empty=,Name=Den'),
    ['servicerequestcommand', 'Den-AppleTV-1-SVC_AV_TV-PowerOn', 'Level', '50', 'Name', 'Den'],
  );
  const out = await h.rawExchange(clientPort, 'servicerequestcommand Den-AppleTV-1-SVC_AV_TV-PowerOn:Level=50\n');
  assert.equal(out, '[servicerequestcommand]\n[Den-AppleTV-1-SVC_AV_TV-PowerOn]\n[Level]\n[50]\n');
});

test('commands outside the allow-list are dropped without running anything', async () => {
  assert.equal(await h.rawExchange(clientPort, 'rm -rf /\n'), '');
  assert.equal(await h.rawExchange(clientPort, 'GET /%E0%A4%A HTTP/1.1\r\n\r\n'), '', 'bad %-encoding');
});

test('dashboard API runs commands and reports status', async () => {
  const { json } = await hub.post('/api/scli/exec', { command: 'userzones' });
  assert.equal(json.output, '[userzones]\n');
  assert.equal((await hub.post('/api/scli/exec', { command: 'shutdown' })).status, 400);

  const sock = net.connect(savantPort, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  try {
    const status = await h.waitFor(async () => {
      const s = (await hub.get('/api/scli/status')).json;
      return s.savantConnected && s;
    }, { what: 'Savant connection' });
    assert.equal(status.scliFound, true);

    const lutronOff = (await hub.get('/api/hub')).json.integrations.find((i) => i.id === 'scli');
    assert.equal(lutronOff.status.level, 'ok');
  } finally {
    sock.destroy();
  }
});

test('switching off does not hang when several Savant connections are open', async () => {
  const connect = () => new Promise((resolve) => {
    const s = net.connect(savantPort, '127.0.0.1', () => resolve(s));
    s.on('error', () => {});
  });
  const older = await connect();
  const newer = await connect();
  try {
    const started = Date.now();
    const res = await hub.put('/api/hub/integrations/scli', { enabled: false });
    assert.equal(res.json.running, false);
    assert.ok(Date.now() - started < 2000, 'stop() returned promptly');
    await h.waitFor(() => older.destroyed && newer.destroyed, { what: 'connections dropped' });
  } finally {
    older.destroy();
    newer.destroy();
    await hub.put('/api/hub/integrations/scli', { enabled: true });
  }
});

test('unknown paths under an integration are 404, not the legacy Lutron 503', async () => {
  // Lutron is off in this suite, and it owns the legacy /api/* root.
  assert.equal((await hub.get('/api/scli/nope')).status, 404);
  assert.equal((await hub.get('/api/hub/nope')).status, 404);
  assert.equal((await hub.get('/api/zone/query?id=1')).status, 503);
});

test('disabled integration answers 503 and frees its ports', async () => {
  await hub.put('/api/hub/integrations/scli', { enabled: false });
  assert.equal((await hub.get('/api/scli/status')).status, 503);
  await assert.rejects(h.rawExchange(clientPort, 'userzones\n'), /ECONNREFUSED|timed out/);
  await hub.put('/api/hub/integrations/scli', { enabled: true });
  assert.equal(await h.rawExchange(clientPort, 'userzones\n'), '[userzones]\n');
});
