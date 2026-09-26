/**
 * The dashboard password: hashing and login cookies (core/auth.js), the gate in front of the
 * dashboard, API and WebSocket (web/access.js), and the CLI the installer and
 * scripts/reset-password use. Requests from the Mac itself (Savant's profiles) never need it.
 */
const h = require('./support/harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const { AuthStore, hashPassword, verifyPassword, validatePassword, SESSION_MS } = require('../SplycedBoard/src/core/auth');

const AUTH_FILE = path.join(h.DATA_DIR, 'auth.json');
const CLI = path.join(__dirname, '..', 'SplycedBoard', 'src', 'cli.js');
const cli = (args, input) => execFileSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, SPLYCEDBOARD_HOME: h.HOME },
  input,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});

let remote; // a hub that takes these requests for another device's
let localHub; // one that trusts this Mac, as installed

before(async () => {
  h.setEnabled({ lutron: false, scli: false, appletv: false });
  remote = await h.startHub({ trustLocal: false });
  localHub = await h.startHub();
});

after(async () => {
  await remote?.stop();
  await localHub?.stop();
});

/** A request with a cookie jar of one. */
function browser(hub) {
  let cookie = '';
  const send = async (method, url, body) => {
    const res = await fetch(hub.base + url, {
      method,
      redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, location: res.headers.get('location') };
  };
  return { send, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

function openSocket(hub, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${hub.base.replace('http', 'ws')}/ws`, { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('message', (data) => {
      ws.close();
      resolve({ ok: true, first: JSON.parse(String(data)) });
    });
    ws.once('unexpected-response', (req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.once('error', () => resolve({ ok: false }));
  });
}

test('passwords are stored as scrypt hashes and checked in constant time', () => {
  const stored = hashPassword('correct horse');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(stored, hashPassword('correct horse'), 'salted');
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('correct hors', stored), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.match(validatePassword('12345'), /at least 6/);
  assert.equal(validatePassword('123456'), null);
  assert.match(validatePassword('with\nnewline'), /line breaks/);
});

test('login cookies are signed, run out, and all end when the password changes', () => {
  const file = path.join(h.HOME, 'unit-auth.json');
  const store = new AuthStore(file);
  assert.equal(store.isSet(), false);
  assert.equal(store.issue(), null, 'no password, no logins');
  store.setPassword('first-pass');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const token = store.issue();
  assert.equal(store.verify(token), true);
  assert.equal(store.verify(`${token}x`), false, 'tampered');
  assert.equal(store.verify(token, Date.now() + SESSION_MS + 1000), false, 'ran out');
  // Another process (scripts/reset-password) writes the file: seen without a restart.
  new AuthStore(file).setPassword('second-pass');
  assert.equal(store.check('second-pass'), true);
  assert.equal(store.verify(token), false, 'every login ends with a new password');
  store.clear();
  assert.equal(store.isSet(), false);
});

test('with no password, everything is open', async () => {
  const b = browser(remote);
  const hub = await b.send('GET', '/api/hub');
  assert.equal(hub.status, 200);
  assert.deepEqual(hub.json.auth, { passwordSet: false, local: false, loggedIn: false });
  assert.equal((await b.send('GET', '/')).status, 200);
  assert.equal((await b.send('GET', '/login')).status, 302, 'nothing to log in to');
  assert.equal((await openSocket(remote)).ok, true);
});

test('a password closes the dashboard, its API and WebSocket to other devices until they log in', async () => {
  const owner = browser(remote);
  const set = await owner.send('PUT', '/api/auth/password', { password: 'splyced-1' });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json, { passwordSet: true, local: false, loggedIn: true });
  assert.ok(owner.cookie, 'whoever sets it stays logged in');

  const stranger = browser(remote);
  const api = await stranger.send('GET', '/api/hub');
  assert.equal(api.status, 401);
  assert.deepEqual(api.json, { error: 'Log in to SplycedBoard first', login: true });
  assert.equal((await stranger.send('GET', '/api/samsungtv/tvs')).status, 401, 'integration APIs too');
  assert.equal((await stranger.send('POST', '/api/hub/restart')).status, 401);
  const page = await stranger.send('GET', '/');
  assert.deepEqual([page.status, page.location], [302, '/login?next=%2F']);
  assert.equal((await stranger.send('GET', '/js/app.js')).status, 302);
  assert.equal((await stranger.send('GET', '/login')).status, 200, 'the login page');
  assert.equal((await stranger.send('GET', '/css/app.css')).status, 200, 'and what it needs');
  assert.deepEqual(await openSocket(remote), { ok: false, status: 401 });

  const wrong = await stranger.send('POST', '/api/auth/login', { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(stranger.cookie, '');
  const right = await stranger.send('POST', '/api/auth/login', { password: 'splyced-1' });
  assert.equal(right.status, 200);
  assert.match(stranger.cookie, /^splycedboard_session=/);
  const hub = await stranger.send('GET', '/api/hub');
  assert.equal(hub.status, 200);
  assert.deepEqual(hub.json.auth, { passwordSet: true, local: false, loggedIn: true });
  assert.equal((await stranger.send('GET', '/login?next=%2F%23%2Fsettings')).location, '/#/settings', 'logged in: straight back');
  assert.equal((await stranger.send('GET', '/login?next=%2F%2Fevil.example')).location, '/', 'only ever back to this dashboard');
  const socket = await openSocket(remote, stranger.cookie);
  assert.equal(socket.ok, true);
  assert.equal(socket.first.type, 'integrations');

  // Logging out ends it for that browser only
  await stranger.send('POST', '/api/auth/logout');
  assert.equal(stranger.cookie, '');
  assert.equal((await stranger.send('GET', '/api/hub')).status, 401);
  assert.equal((await owner.send('GET', '/api/hub')).status, 200);
});

test('Savant on the Mac itself never needs the password', async () => {
  assert.equal(fs.existsSync(AUTH_FILE), true, 'set by the previous test');
  const local = await localHub.get('/api/hub');
  assert.equal(local.status, 200);
  assert.deepEqual(local.json.auth, { passwordSet: true, local: true, loggedIn: false });
  assert.equal((await localHub.get('/api/hub/profile-report?integration=lutron&version=1.0')).status, 200);
  assert.equal((await openSocket(localHub)).ok, true);
});

test('changing the password takes the current one, and ends every other login', async () => {
  const owner = browser(remote);
  await owner.send('POST', '/api/auth/login', { password: 'splyced-1' });
  const other = browser(remote);
  await other.send('POST', '/api/auth/login', { password: 'splyced-1' });

  assert.equal((await owner.send('PUT', '/api/auth/password', { current: 'wrong-one', password: 'splyced-2' })).status, 403);
  assert.match((await owner.send('PUT', '/api/auth/password', { current: 'splyced-1', password: 'short' })).json.error, /at least 6/);
  const changed = await owner.send('PUT', '/api/auth/password', { current: 'splyced-1', password: 'splyced-2' });
  assert.equal(changed.status, 200);
  assert.equal((await owner.send('GET', '/api/hub')).status, 200, 'the browser that changed it stays in');
  assert.equal((await other.send('GET', '/api/hub')).status, 401, 'every other login ends');
  assert.equal((await other.send('POST', '/api/auth/login', { password: 'splyced-2' })).status, 200);
});

test('the CLI sets and clears it for the installer and scripts/reset-password; the service follows at once', async () => {
  const before = browser(remote);
  assert.equal((await before.send('POST', '/api/auth/login', { password: 'splyced-2' })).status, 200);

  assert.equal(cli(['has-password']), 'yes\n');
  assert.throws(() => cli(['set-password'], 'abc'), /at least 6 characters/);
  cli(['set-password'], 'reset-from-mac\n'); // what scripts/reset-password pipes in
  assert.equal(cli(['has-password']), 'yes\n');

  // The running service takes it without a restart: logins so far are over, the new one works.
  assert.equal((await before.send('GET', '/api/hub')).status, 401);
  const after = browser(remote);
  assert.equal((await after.send('POST', '/api/auth/login', { password: 'reset-from-mac' })).status, 200);
  assert.equal((await after.send('GET', '/api/hub')).status, 200);

  cli(['clear-password']);
  assert.equal(cli(['has-password']), 'no\n');
  assert.equal((await browser(remote).send('GET', '/api/hub')).status, 200, 'open again');

  cli(['enable', 'appletv']);
  const saved = h.readJson(path.join(h.DATA_DIR, 'hub.json')).integrations;
  assert.deepEqual([saved.appletv.enabled, saved.lutron.enabled], [true, false], 'enable leaves the others alone');
});

test('wrong passwords lock that address out for a while', async () => {
  cli(['set-password'], 'lock-test-1');
  const guesser = browser(remote);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await guesser.send('POST', '/api/auth/login', { password: `guess-${i}` })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 429, 429]);
  const locked = await guesser.send('POST', '/api/auth/login', { password: 'lock-test-1' });
  assert.equal(locked.status, 429, 'even the right one, until the lockout ends');
  assert.match(locked.json.error, /Try again in \d+ seconds/);
});
