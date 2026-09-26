/**
 * Who may use the dashboard and its API.
 *
 * Once a password is set (core/auth.js), a request from another device needs a login: the
 * signed cookie /api/auth/login hands out. A request from this Mac itself never does: that's
 * how Savant's profiles call the integrations (127.0.0.1, or the host's own address), and how
 * the installer and scripts/status check on the service.
 *
 *   middleware         lets a request through, or answers 401 (API) / sends a browser to /login
 *   loginPage          GET /login
 *   router             /api/auth: state, login, logout, change or remove the password
 *   allowUpgrade(req)  the same test, for the dashboard's WebSocket
 *   describe(req)      { passwordSet, local, loggedIn }
 */
const os = require('os');
const path = require('path');
const express = require('express');

const COOKIE = 'splycedboard_session';
// What the login page itself needs.
const OPEN_PATHS = new Set(['/login', '/api/auth/login', '/css/app.css', '/img/logo.svg', '/favicon.ico']);
// Wrong passwords: 5 in 10 minutes locks that address out for a minute, then two, four…
const LIMIT = { tries: 5, windowMs: 10 * 60 * 1000, lockMs: 60 * 1000, maxLockMs: 60 * 60 * 1000 };

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* not ours */ }
  }
  return out;
}

/**
 * @param store       core/auth AuthStore
 * @param trustLocal  requests from this Mac need no login (tests turn it off)
 * @param publicDir   where login.html is
 */
function createAccess({ store, trustLocal = true, publicDir, log }) {
  let local = { at: 0, addresses: new Set() };
  const localAddresses = () => {
    if (Date.now() - local.at > 30 * 1000) {
      const addresses = new Set(['127.0.0.1', '::1']);
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) addresses.add(a.address);
      local = { at: Date.now(), addresses };
    }
    return local.addresses;
  };
  const isLocal = (req) => trustLocal && localAddresses().has(clientIp(req));
  const loggedIn = (req) => store.verify(cookies(req)[COOKIE]);
  const allowed = (req) => !store.isSet() || isLocal(req) || loggedIn(req);

  const describe = (req) => ({ passwordSet: store.isSet(), local: isLocal(req), loggedIn: loggedIn(req) });

  const setCookie = (res) => res.append('Set-Cookie', `${COOKIE}=${store.issue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);
  const clearCookie = (res) => res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

  // ── Wrong passwords ────────────────────────────────────────────────────────
  const attempts = new Map(); // address → { times: [], lockedUntil, locks }
  const waitFor = (ip) => Math.max(0, (attempts.get(ip)?.lockedUntil || 0) - Date.now());
  const failed = (ip) => {
    const now = Date.now();
    const a = attempts.get(ip) || { times: [], lockedUntil: 0, locks: 0 };
    a.times = a.times.filter((t) => now - t < LIMIT.windowMs).concat(now);
    if (a.times.length >= LIMIT.tries) {
      a.lockedUntil = now + Math.min(LIMIT.lockMs * 2 ** a.locks, LIMIT.maxLockMs);
      a.locks += 1;
      a.times = [];
      log.warn(`${ip}: too many wrong dashboard passwords, locked out for ${Math.round((a.lockedUntil - now) / 1000)} s`);
    }
    attempts.set(ip, a);
  };
  const tooMany = (res, ip) => res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(waitFor(ip) / 1000)} seconds.` });

  // ── The gate ───────────────────────────────────────────────────────────────
  function middleware(req, res, next) {
    if (allowed(req) || OPEN_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/') || req.path === '/ws') {
      return res.status(401).json({ error: 'Log in to SplycedBoard first', login: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).type('text/plain').send('Log in to SplycedBoard first');
  }

  function loginPage(req, res) {
    if (allowed(req)) {
      const next = String(req.query.next || '/');
      return res.redirect(302, next.startsWith('/') && !next.startsWith('//') ? next : '/');
    }
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'login.html'));
  }

  // ── /api/auth ──────────────────────────────────────────────────────────────
  const router = express.Router();

  router.get('/', (req, res) => res.json(describe(req)));

  router.post('/login', (req, res) => {
    if (!store.isSet()) return res.json({ ok: true });
    const ip = clientIp(req);
    if (waitFor(ip)) return tooMany(res, ip);
    if (!store.check(req.body?.password)) {
      failed(ip);
      log.warn(`Wrong dashboard password from ${ip}`);
      return waitFor(ip) ? tooMany(res, ip) : res.status(401).json({ error: 'That isn\'t the password' });
    }
    attempts.delete(ip);
    setCookie(res);
    log.info(`Dashboard login from ${ip}`);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    clearCookie(res);
    res.json({ ok: true });
  });

  // Changing or removing it takes the current password, wherever the request comes from:
  // scripts/reset-password is the way in for someone at the Mac who forgot it.
  const currentOk = (req, res) => {
    if (!store.isSet()) return true;
    const ip = clientIp(req);
    if (waitFor(ip)) {
      tooMany(res, ip);
      return false;
    }
    if (store.check(req.body?.current)) return true;
    failed(ip);
    res.status(403).json({ error: 'The current password isn\'t right' });
    return false;
  };

  router.put('/password', (req, res) => {
    if (!currentOk(req, res)) return;
    try {
      store.setPassword(req.body?.password);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    setCookie(res); // this browser stays logged in; every other login ends
    log.info(`Dashboard password ${req.body?.current ? 'changed' : 'set'} from ${clientIp(req)}`);
    res.json({ ...describe(req), loggedIn: true });
  });

  router.delete('/password', (req, res) => {
    if (!currentOk(req, res)) return;
    store.clear();
    clearCookie(res);
    log.warn(`Dashboard password removed from ${clientIp(req)}: anyone on the network can use the dashboard`);
    res.json(describe(req));
  });

  return { middleware, loginPage, router, allowUpgrade: allowed, describe, COOKIE };
}

module.exports = { createAccess, COOKIE };
