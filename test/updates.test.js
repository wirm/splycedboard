/**
 * Updates from GitHub releases (core/updates.js), against a stand-in for GitHub's API and
 * downloads. The installers here are small scripts, run the way the update's launchd job
 * runs them, but without launchd.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Updater, githubRepo, compareReleases } = require('../SplycedBoard/src/core/updates');
const pkg = require('../SplycedBoard/package.json');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** A SplycedBoard.tar.gz holding just package.json and an install script. */
function fakePackage(version, installScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pkg-'));
  fs.mkdirSync(path.join(dir, 'SplycedBoard'));
  fs.writeFileSync(path.join(dir, 'SplycedBoard', 'package.json'), JSON.stringify({ name: 'splycedboard', version }));
  fs.writeFileSync(path.join(dir, 'SplycedBoard', 'install'), `#!/bin/bash\n${installScript}\n`, { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(dir, 'p.tgz'), '-C', dir, 'SplycedBoard']);
  return fs.readFileSync(path.join(dir, 'p.tgz'));
}

// GitHub: the releases API, and a download that redirects to the file, as github.com does.
const github = { release: null, archive: null, digest: undefined, limitedUntil: 0, apiCalls: 0, notYet: 0 };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/repos/wirm/splycedboard/releases/latest') {
      github.apiCalls++;
      if (github.limitedUntil) {
        // As GitHub refuses a network over its 60 an hour: the time it takes checks again
        res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(github.limitedUntil) });
        return res.end('{"message":"API rate limit exceeded"}');
      }
      if (!github.release) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"message":"Not Found"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        tag_name: `v${github.release}`,
        name: `SplycedBoard v${github.release}`,
        html_url: `https://github.com/wirm/splycedboard/releases/tag/v${github.release}`,
        published_at: '2026-09-25T19:03:00Z',
        assets: [{
          name: 'SplycedBoard.tar.gz',
          size: github.archive.length,
          digest: github.digest === undefined ? `sha256:${sha256(github.archive)}` : github.digest,
          browser_download_url: `${base}/wirm/splycedboard/releases/download/v${github.release}/SplycedBoard.tar.gz`,
        }],
      }));
    }
    if (req.url.startsWith('/wirm/splycedboard/releases/download/') && github.notYet > 0) {
      // A release just published: listed, but its file not downloadable yet
      github.notYet--;
      res.writeHead(404);
      return res.end('Not Found');
    }
    if (req.url.startsWith('/wirm/splycedboard/releases/download/')) {
      res.writeHead(302, { location: '/release-assets/7f3a9c?sig=abc' });
      return res.end();
    }
    if (req.url.startsWith('/release-assets/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(github.archive);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function release(version, installScript = 'exit 0', packageVersion = version) {
  github.release = version;
  github.archive = fakePackage(packageVersion, installScript);
}

function updater({ version = '2.0.0', managed = true, launch, now } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-update-'));
  return new Updater({ version, repo: 'wirm/splycedboard', dataDir, managed, apiBase: base, launch, watchEveryMs: 50, now, retryDelayMs: 20 });
}

// Runs the installer as launchdLauncher's job does, minus launchd.
function runDirectly(calls = []) {
  return (spec) => {
    calls.push(spec);
    const out = fs.openSync(spec.logFile, 'a');
    spawn('/bin/bash', ['-c', '/bin/bash "$0" --yes --headless; echo $? > "$1"', spec.installer, spec.resultFile], {
      cwd: spec.cwd,
      stdio: ['ignore', out, out],
    });
    fs.closeSync(out);
  };
}

const finished = (u) => h.waitFor(() => !u.status().installing, { timeout: 10000, what: 'the installer to finish' });

test('the GitHub repository comes from package.json', () => {
  assert.equal(githubRepo(pkg), 'wirm/splycedboard');
  assert.equal(githubRepo({ repository: 'git@github.com:someone/thing.git' }), 'someone/thing');
  assert.equal(githubRepo({}), null);
});

test('release versions compare as numbers, and a release is newer than its betas', () => {
  assert.equal(compareReleases('2.0.10', '2.0.9'), 1);
  assert.equal(compareReleases('2.1.0', '2.1.0-beta.1'), 1);
  assert.equal(compareReleases('2.0.0', '2.0.0'), 0);
  assert.equal(compareReleases('2.0.0', '2.1.0'), -1);
});

test('check() finds a newer release, or says this is the newest', async () => {
  release('2.1.0');
  let s = await updater({ version: '2.0.0' }).check();
  assert.equal(s.available, true);
  assert.equal(s.latest.version, '2.1.0');
  assert.match(s.latest.asset.digest, /^sha256:[0-9a-f]{64}$/);

  s = await updater({ version: '2.1.0' }).check();
  assert.equal(s.available, false);
  assert.equal(s.error, null);
});

test('check() reports trouble reaching GitHub', async () => {
  github.release = null;
  const u = updater();
  await assert.rejects(u.check(), (err) => err.status === 502 && /no published releases/.test(err.message));
  assert.match(u.status().error, /^Couldn't check for updates/);
});

test("GitHub's limit: no more asking until the time it gives, which the dashboard shows", async () => {
  release('2.1.0');
  const clock = { t: Date.parse('2026-09-25T23:13:42Z') };
  github.limitedUntil = (clock.t + 9 * 60 * 1000) / 1000; // 9 minutes on
  github.apiCalls = 0;
  const u = updater({ now: () => clock.t });
  try {
    await assert.rejects(u.check(), (err) => err.status === 429 && /60 update checks an hour.*again in 9 minutes/.test(err.message));
    assert.equal(u.status().retryAt, new Date(github.limitedUntil * 1000).toISOString());
    for (let i = 0; i < 5; i++) await assert.rejects(u.check(), /again in 9 minutes/); // clicks while refused
    assert.equal(github.apiCalls, 1, 'no more asking before then');

    clock.t += 9 * 60 * 1000 + 1000;
    github.limitedUntil = 0;
    const s = await u.check();
    assert.deepEqual([s.latest.version, s.retryAt, s.error, github.apiCalls], ['2.1.0', null, null, 2]);
  } finally {
    github.limitedUntil = 0;
  }
});

test('"Check now" just after a check reuses its answer; after 30 seconds it asks again', async () => {
  release('2.1.0');
  const clock = { t: Date.parse('2026-09-25T23:00:00Z') };
  github.apiCalls = 0;
  const u = updater({ now: () => clock.t });
  await u.check();
  clock.t += 10 * 1000;
  await u.check();
  assert.equal(github.apiCalls, 1);
  clock.t += 25 * 1000;
  await u.check();
  assert.equal(github.apiCalls, 2);
});

test('only the background service installs, and only something newer', async () => {
  release('2.1.0');
  await assert.rejects(updater({ managed: false }).install(), (err) => err.status === 409 && /background service/.test(err.message));
  await assert.rejects(updater({ version: '2.1.0' }).install(), (err) => err.status === 409 && /already the newest/.test(err.message));
});

test("a download that doesn't match its checksum isn't installed", async () => {
  release('2.1.0');
  github.digest = `sha256:${'0'.repeat(64)}`;
  const calls = [];
  const u = updater({ launch: runDirectly(calls) });
  try {
    await assert.rejects(u.install(), (err) => err.status === 502 && /checksum/.test(err.message));
  } finally {
    github.digest = undefined;
  }
  assert.equal(calls.length, 0, 'the installer never ran');
  assert.equal(u.status().installing, null);
  assert.equal(u.status().result.ok, false);
});

test("a download that isn't the release it claims to be isn't installed", async () => {
  release('2.1.0', 'exit 0', '9.9.9');
  const calls = [];
  await assert.rejects(updater({ launch: runDirectly(calls) }).install(), /isn't SplycedBoard v2\.1\.0/);
  assert.equal(calls.length, 0);
});

test('install() downloads through the redirect, verifies, unpacks, and runs the installer', async () => {
  release('2.1.0', 'echo "installer ran: $*"');
  const calls = [];
  const u = updater({ launch: runDirectly(calls) });
  const states = [];
  u.on('change', (s) => states.push(Boolean(s.installing)));

  const s = await u.install();
  assert.equal(s.installing.version, '2.1.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].installer, path.join(u.workDir, 'SplycedBoard', 'install'));
  assert.ok(fs.existsSync(path.join(u.workDir, 'pending.json')), 'remembered for the new version to report');

  // Normally the installer stops this process; still running, it hears the result itself.
  await finished(u);
  assert.equal(u.status().result.ok, true);
  assert.match(u.logTail(), /installer ran: --yes --headless/);
  assert.ok(!fs.existsSync(path.join(u.workDir, 'pending.json')));
  assert.deepEqual([states.includes(true), states.at(-1)], [true, false]);
});

test("a release just out, whose file isn't downloadable yet, is tried again; still missing, it says so", async () => {
  release('2.1.0');
  github.notYet = 2;
  const calls = [];
  const u = updater({ launch: runDirectly(calls) });
  await u.install();
  assert.equal(calls.length, 1, 'installed on the third try');
  await finished(u);

  github.notYet = 10;
  await assert.rejects(updater({ launch: runDirectly([]) }).install(), /isn't on GitHub yet \(HTTP 404\)/);
  github.notYet = 0;
});

test('two Update clicks at once start one installer', async () => {
  release('2.1.0', 'sleep 0.3');
  const calls = [];
  const u = updater({ launch: runDirectly(calls) });
  const results = await Promise.allSettled([u.install(), u.install()]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /Already updating to v2\.1\.0/);
  assert.equal(calls.length, 1);
  await finished(u);
});

test('an installer that fails is reported, with its output', async () => {
  release('2.1.0', 'echo "npm ERR! network"; exit 3');
  const u = updater({ launch: runDirectly() });
  await u.install();
  await finished(u);
  assert.equal(u.status().result.ok, false);
  assert.match(u.status().result.message, /exit code 3/);
  assert.match(u.logTail(), /npm ERR! network/);
});

test('after the restart, the new version says how the update went', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-update-'));
  const pending = () => {
    fs.mkdirSync(path.join(dataDir, 'update'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'update', 'pending.json'), JSON.stringify({ from: '2.0.0', to: '2.1.0' }));
  };
  pending();
  let u = new Updater({ version: '2.1.0', repo: 'wirm/splycedboard', dataDir });
  assert.deepEqual([u.status().result.ok, u.status().result.message], [true, 'Updated from v2.0.0 to v2.1.0.']);

  pending();
  u = new Updater({ version: '2.0.0', repo: 'wirm/splycedboard', dataDir });
  assert.equal(u.status().result.ok, false);
  assert.match(u.status().result.message, /didn't finish; still running v2\.0\.0/);
});

test('dashboard API: status in the snapshot, check, and install refused outside the service', async () => {
  release('2.1.0');
  const hub = await h.startHub({ updates: updater({ version: '2.0.0', managed: false }) });
  try {
    assert.equal((await hub.get('/api/hub')).json.update.current, '2.0.0');
    const checked = await hub.post('/api/hub/update/check');
    assert.equal(checked.status, 200);
    assert.equal(checked.json.available, true);
    const install = await hub.post('/api/hub/update/install');
    assert.equal(install.status, 409);
    assert.match(install.json.error, /background service/);
    assert.equal(install.json.update.installing, null);
  } finally {
    await hub.stop();
  }
});
