/**
 * The dashboard's password.
 *
 * data/auth.json holds { hash, secret, changedAt }: the password as a scrypt hash, and the
 * key login cookies are signed with. Without a hash there's no password: everything is open,
 * as before passwords existed. Setting or changing the password makes a new secret, which
 * ends every login.
 *
 * Built-in modules only: the installer and scripts/reset-password use this through src/cli.js
 * before dependencies are installed. The service re-reads the file when it changes, so a
 * reset from the Mac takes effect without a restart.
 *
 *   hashPassword(pw) / verifyPassword(pw, hash)
 *   validatePassword(pw)   → what's wrong with it, or null
 *   AuthStore(file)        isSet() · check(pw) · setPassword(pw) · clear() · issue() · verify(token)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_LENGTH = 6;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password) {
  const pw = String(password ?? '');
  if (pw.length < MIN_LENGTH) return `The password needs at least ${MIN_LENGTH} characters`;
  if (pw.length > 256) return 'That password is too long';
  if (/[\r\n]/.test(pw)) return 'The password can\'t contain line breaks';
  return null;
}

class AuthStore {
  constructor(file) {
    this.file = file;
    this.cache = null; // { mtimeMs, data }
  }

  /** The file's contents, re-read only when it changed (the reset script writes it). */
  _data() {
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.cache = { mtimeMs: null, data: {} };
      return this.cache.data;
    }
    if (this.cache?.mtimeMs === mtimeMs) return this.cache.data;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch { /* unreadable: treated as no password, like a missing file */ }
    this.cache = { mtimeMs, data };
    return data;
  }

  _write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }

  isSet() {
    return Boolean(this._data().hash);
  }

  check(password) {
    const { hash } = this._data();
    return Boolean(hash) && verifyPassword(password, hash);
  }

  setPassword(password) {
    const problem = validatePassword(password);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    this._write({ hash: hashPassword(password), secret: crypto.randomBytes(32).toString('hex'), changedAt: new Date().toISOString() });
  }

  clear() {
    this._write({ changedAt: new Date().toISOString() });
  }

  /** A login cookie's value: when it runs out, a nonce, and their signature. */
  issue(now = Date.now()) {
    const { secret } = this._data();
    if (!secret) return null;
    const body = `${now + SESSION_MS}.${crypto.randomBytes(9).toString('base64url')}`;
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  }

  verify(token, now = Date.now()) {
    const { secret } = this._data();
    const parts = String(token || '').split('.');
    if (!secret || parts.length !== 3) return false;
    const [expires, nonce, sig] = parts;
    if (!(Number(expires) > now)) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${expires}.${nonce}`).digest();
    const actual = Buffer.from(sig, 'base64url');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
}

module.exports = { MIN_LENGTH, SESSION_MS, hashPassword, verifyPassword, validatePassword, AuthStore };
