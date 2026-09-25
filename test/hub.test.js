/**
 * Hub-level behaviour: registry/manifests, the installer CLI, legacy config import,
 * failure isolation between integrations, and the plist writer.
 */
const h = require('./support/harness');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const registry = require('../SplycedBoard/src/integrations');
const paths = require('../SplycedBoard/src/core/paths');
const { JsonStore } = require('../SplycedBoard/src/core/store');
const { migrateLegacyConfig } = require('../SplycedBoard/src/integrations/lutron/legacy-config');
const { toPlist } = require('../SplycedBoard/src/core/plist');

const CLI = path.join(__dirname, '..', 'SplycedBoard', 'src', 'cli.js');
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: process.env, encoding: 'utf8' });

test('every integration has a valid manifest, implementation and Savant profile', () => {
  for (const m of registry.manifests()) {
    assert.ok(m.name && m.description, `${m.id}: name/description`);
    assert.equal(typeof registry.load(m.id).create, 'function', `${m.id}: create()`);
    if (m.profile) assert.ok(fs.existsSync(path.join(paths.PROFILES_DIR, m.profile)), `${m.id}: profiles/${m.profile}`);
  }
});

test('installer CLI lists integrations and saves the chosen set', () => {
  const lines = cli('choices').trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(lines.map(([id]) => id), registry.manifests().map((m) => m.id));

  cli('set-enabled', 'scli');
  const saved = h.readJson(path.join(h.DATA_DIR, 'hub.json'));
  assert.equal(saved.integrations.lutron.enabled, false);
  assert.equal(saved.integrations.scli.enabled, true);
  assert.deepEqual(JSON.parse(cli('list')).map((i) => [i.id, i.enabled]), [['lutron', false], ['appletv', false], ['scli', true]]);

  assert.match(cli('profiles', 'lutron,scli'), /\/lutron_leap bridge\.xml\n.*\/ip_requests\.xml\n$/);
  assert.throws(() => cli('set-enabled', 'nope'), /Unknown integration/);
});

test('imports pairing from the standalone bridge exactly once', () => {
  const legacy = path.join(h.HOME, 'legacy-savant-lutron');
  fs.mkdirSync(path.join(legacy, 'certs'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ processor: { id: '10-0-0-5', host: '10.0.0.5' }, componentName: 'LEAP' }));
  fs.writeFileSync(path.join(legacy, 'certs', '10-0-0-5-client.key'), 'KEY');

  const settings = new JsonStore(path.join(h.HOME, 'migrate', 'settings.json'));
  const certDir = path.join(h.HOME, 'migrate', 'certs');
  const log = { info() {}, warn() {} };

  assert.equal(migrateLegacyConfig({ settings, certDir, log, legacyDirs: [path.join(h.HOME, 'missing'), legacy] }), true);
  assert.deepEqual(settings.load(), { processor: { id: '10-0-0-5', host: '10.0.0.5' }, componentName: 'LEAP' });
  assert.equal(fs.readFileSync(path.join(certDir, '10-0-0-5-client.key'), 'utf8'), 'KEY');

  settings.update((s) => { s.componentName = 'Changed'; });
  assert.equal(migrateLegacyConfig({ settings, certDir, log, legacyDirs: [legacy] }), false, 'never overwrites existing config');
  assert.equal(settings.load().componentName, 'Changed');
});

test('one integration failing to start does not take down the others', async () => {
  const blocker = net.createServer();
  const busyPort = await h.freePort();
  await new Promise((r) => blocker.listen(busyPort, '0.0.0.0', r));

  h.patchSettings('lutron', { telnetPort: busyPort });
  h.patchSettings('scli', { clientPort: await h.freePort(), savantPort: await h.freePort() });
  h.setEnabled({ lutron: true, scli: true });
  const hub = await h.startHub();
  try {
    const { json } = await hub.get('/api/hub');
    const byId = Object.fromEntries(json.integrations.map((i) => [i.id, i]));
    assert.equal(byId.lutron.running, false);
    assert.equal(byId.lutron.status.level, 'error');
    assert.match(byId.lutron.status.text, new RegExp(`Port ${busyPort} is already in use`));
    assert.equal(byId.scli.running, true);
    assert.equal((await hub.get('/api/zone/query?id=1')).status, 503);
  } finally {
    await hub.stop();
    blocker.close();
  }
});

test('hub settings toggle verbose logging', async () => {
  h.setEnabled({ lutron: false, scli: false });
  const hub = await h.startHub();
  try {
    assert.deepEqual((await hub.put('/api/hub/settings', { verbose: false })).json, { verbose: false });
    assert.equal(h.readJson(path.join(h.DATA_DIR, 'hub.json')).verbose, false);
    const { json } = await hub.get('/api/hub/logs?limit=5');
    assert.ok(Array.isArray(json.entries) && json.entries.length <= 5);
    assert.equal((await hub.post('/api/hub/restart')).status, 409, 'restart needs launchd');
  } finally {
    await hub.stop();
  }
});

test('plist writer escapes text and nests containers', () => {
  const xml = toPlist({ Name: 'A & <B>', Flags: [true, false], Nested: { Count: 3, Empty: [] } });
  assert.equal(xml, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Name</key>',
    '\t<string>A &amp; &lt;B&gt;</string>',
    '\t<key>Flags</key>',
    '\t<array>',
    '\t\t<true/>',
    '\t\t<false/>',
    '\t</array>',
    '\t<key>Nested</key>',
    '\t<dict>',
    '\t\t<key>Count</key>',
    '\t\t<integer>3</integer>',
    '\t\t<key>Empty</key>',
    '\t\t<array/>',
    '\t</dict>',
    '</dict>',
    '</plist>',
  ].join('\n'));
});
