/**
 * Savant profile versions: the ReportProfileVersion calls the profiles make, what the hub
 * makes of them, and spotting a profile too old to report.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ProfileTracker, readProfile, compareVersions, GRACE_MS, ACTIVE_MS } = require('../SplycedBoard/src/core/profiles');

// ── The tracker, on a clock the tests move ──────────────────────────────────

function tracker() {
  let now = 1_000_000;
  const logs = [];
  const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) };
  const profiles = new ProfileTracker({ log, now: () => now });
  profiles.register('lutron', { name: 'Lutron LEAP', file: 'lutron_leap bridge.xml', version: '1.12', reports: true });
  let changes = 0;
  profiles.on('change', () => changes++);
  return { profiles, logs, advance: (ms) => { now += ms; }, changes: () => changes };
}

test('versions compare part by part as whole numbers', () => {
  assert.equal(compareVersions('1.9', '1.10'), -1);
  assert.equal(compareVersions('1.12', '1.11'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});

test("the version shipped is the profile's own rpm_xml_version, and whether it reports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-profile-'));
  const file = path.join(dir, 'x.xml');
  fs.writeFileSync(file, '<?xml version="1.0"?>\n<component\n    manufacturer="X"\n    rpm_xml_version="3.4">\n<other rpm_xml_version="9"/></component>');
  assert.deepEqual(readProfile(file), { version: '3.4', reports: false });
  fs.writeFileSync(file, '<component rpm_xml_version="1.0"><action name="ReportProfileVersion"></action></component>');
  assert.deepEqual(readProfile(file), { version: '1.0', reports: true });
  assert.deepEqual(readProfile(path.join(dir, 'missing.xml')), { version: null, reports: false });
});

test('a report of the shipped version is current; an older or newer one is flagged', () => {
  const { profiles, logs } = tracker();
  assert.equal(profiles.report('lutron', '10.0.0.2', '1.12'), 'current');
  assert.equal(profiles.summary('lutron').warning, null);

  assert.equal(profiles.report('lutron', '10.0.0.2', '1.11'), 'older');
  assert.match(profiles.summary('lutron').warning, /version 1\.11 of this profile \(10\.0\.0\.2\), but this SplycedBoard ships 1\.12/);

  assert.equal(profiles.report('lutron', '10.0.0.2', '1.13'), 'newer');
  assert.match(profiles.summary('lutron').warning, /newer than the 1\.12 .*Update SplycedBoard/);

  // Logged once per change, not on every report.
  profiles.report('lutron', '10.0.0.2', '1.13');
  assert.deepEqual(logs.map(([level]) => level), ['info', 'warn', 'warn']);
});

test('Savant calling without reporting is an older profile, once it has had time to report', () => {
  const { profiles, advance } = tracker();
  profiles.traffic('lutron', '127.0.0.1');
  assert.equal(profiles.summary('lutron').sources[0].state, 'pending');
  assert.equal(profiles.summary('lutron').warning, null, 'no warning before Savant has had time to report');

  advance(GRACE_MS);
  profiles.traffic('lutron', '127.0.0.1');
  assert.equal(profiles.summary('lutron').sources[0].state, 'unreported');
  assert.match(profiles.summary('lutron').warning, /older version of this profile \(127\.0\.0\.1\) that doesn't report its version/);

  profiles.report('lutron', '127.0.0.1', '1.12'); // the new profile is in
  assert.equal(profiles.summary('lutron').sources[0].state, 'current');
  assert.equal(profiles.summary('lutron').warning, null);
});

test("a profile that can't report is never flagged for not reporting", () => {
  const { profiles, advance } = tracker();
  profiles.register('scli', { name: 'SCLI Bridge', file: 'ip_requests.xml', version: '2.2', reports: false });
  profiles.traffic('scli', '127.0.0.1');
  advance(GRACE_MS);
  profiles.traffic('scli', '127.0.0.1');
  assert.deepEqual(profiles.summary('scli'), { file: 'ip_requests.xml', version: '2.2', reports: false, sources: [], warning: null });
});

test('each component counts separately, and one that goes quiet drops off', () => {
  const { profiles, advance, changes } = tracker();
  profiles.report('lutron', '10.0.0.2', '1.12');
  profiles.report('lutron', '10.0.0.3', '1.10');
  assert.deepEqual(profiles.summary('lutron').sources.map((s) => [s.device, s.state]), [['10.0.0.2', 'current'], ['10.0.0.3', 'older']]);

  advance(ACTIVE_MS / 2);
  profiles.report('lutron', '10.0.0.2', '1.12');
  advance(ACTIVE_MS / 2 + 1);
  const before = changes();
  profiles.refresh(); // what the 30-second timer does
  assert.deepEqual(profiles.summary('lutron').sources.map((s) => s.device), ['10.0.0.2']);
  assert.equal(profiles.summary('lutron').warning, null);
  assert.equal(changes(), before + 1);
});

// ── Over HTTP, as Savant calls it ───────────────────────────────────────────

let hub;
before(async () => { hub = await h.startHub(); });
after(() => hub.stop());

// Savant's HTTP client, unlike a browser (or Node's fetch), sends no Sec-Fetch-Mode.
function savantGet(url) {
  return new Promise((resolve, reject) => {
    http.get(hub.base + url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

const lutronProfile = async () => (await hub.get('/api/hub')).json.integrations.find((i) => i.id === 'lutron').profileStatus;

test("Savant's calls to an integration count toward spotting an old profile; the dashboard's don't", async () => {
  assert.equal((await hub.get('/api/status')).status, 200); // a browser: not Savant
  assert.deepEqual((await lutronProfile()).sources, []);

  assert.equal(await savantGet('/api/status'), 200); // the Lutron profile's own path
  assert.deepEqual((await lutronProfile()).sources.map((s) => [s.device, s.state]), [['127.0.0.1', 'pending']]);
});

test('the profile reports its version, and the dashboard shows what Savant runs', async () => {
  const shipped = (await lutronProfile()).version;
  assert.match(shipped, /^\d+(\.\d+)+$/);

  let res = await hub.get('/api/hub/profile-report?integration=lutron&version=1.11');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, state: 'older', shipped });
  let profile = await lutronProfile();
  assert.deepEqual(profile.sources.map((s) => [s.device, s.version, s.state]), [['127.0.0.1', '1.11', 'older']]);
  assert.match(profile.warning, /version 1\.11 of this profile/);

  res = await hub.get(`/api/hub/profile-report?integration=lutron&version=${shipped}`);
  assert.equal(res.json.state, 'current');
  profile = await lutronProfile();
  assert.equal(profile.warning, null);
});

test('reports for an unknown integration, or without a version, are refused', async () => {
  assert.equal((await hub.get('/api/hub/profile-report?integration=nope&version=1.0')).status, 404);
  assert.equal((await hub.get('/api/hub/profile-report?integration=lutron&version=latest')).status, 400);
  assert.equal((await hub.get('/api/hub/profile-report?integration=lutron')).status, 400);
});
