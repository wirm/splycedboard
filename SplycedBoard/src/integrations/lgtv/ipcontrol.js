/**
 * LG Network IP Control: plain-text commands on TCP port 9761 ("POWER off", "KEY_ACTION ok",
 * "CURRENT_VOL" → "VOL:12"), switched on in the TV's hidden IP Control Setup menu.
 *
 * 2018 and newer TVs want every message encrypted with the keycode that menu shows:
 *   key       PBKDF2-SHA256(keycode, LG's salt, 16384 rounds) → 16 bytes
 *   message   text + "\r", a space if that fills whole blocks, padded to 16 bytes with
 *             the pad length (as in PKCS#7), AES-128-CBC with a random IV
 *   on wire   the IV (AES-128-ECB) followed by the message
 *   answer    the same way back; the text ends at "\n"
 * (This is how Savant's LG profiles send it, and what github.com/WesSouza/lgtv-ip-control
 * documents.) 2016–2017 models take the text as is.
 */
const crypto = require('crypto');
const net = require('net');

const lan = require('../../core/lan');

const PORTS = { ipControl: 9761 };
const SALT = Buffer.from([0x63, 0x61, 0xb8, 0x0e, 0x9b, 0xdc, 0xa6, 0x63, 0x8d, 0x07, 0x20, 0xf2, 0xcc, 0x56, 0x8f, 0xb9]);
const BLOCK = 16;
const IDLE_MS = 30 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const keys = new Map(); // keycode → derived key (PBKDF2 is slow on purpose)
function deriveKey(keycode) {
  if (!keys.has(keycode)) keys.set(keycode, crypto.pbkdf2Sync(keycode, SALT, 2 ** 14, 16, 'sha256'));
  return keys.get(keycode);
}

function pad(text) {
  let out = text;
  if (out.length % BLOCK === 0) out += ' ';
  const rem = out.length % BLOCK;
  if (rem) out += String.fromCharCode(BLOCK - rem).repeat(BLOCK - rem);
  return out;
}

function encrypt(message, keycode, iv = crypto.randomBytes(BLOCK)) {
  const key = deriveKey(keycode);
  const ecb = crypto.createCipheriv('aes-128-ecb', key, Buffer.alloc(0));
  ecb.setAutoPadding(false);
  const ivEncrypted = Buffer.concat([ecb.update(iv), ecb.final()]);
  const cbc = crypto.createCipheriv('aes-128-cbc', key, iv);
  cbc.setAutoPadding(false);
  const data = Buffer.concat([cbc.update(Buffer.from(pad(`${message}\r`), 'latin1')), cbc.final()]);
  return Buffer.concat([ivEncrypted, data]);
}

/** @returns the answer's text, or null if it isn't whole (or the keycode is wrong) */
function decrypt(buf, keycode) {
  if (buf.length < 2 * BLOCK || buf.length % BLOCK) return null;
  const key = deriveKey(keycode);
  const ecb = crypto.createDecipheriv('aes-128-ecb', key, Buffer.alloc(0));
  ecb.setAutoPadding(false);
  const iv = Buffer.concat([ecb.update(buf.subarray(0, BLOCK)), ecb.final()]);
  const cbc = crypto.createDecipheriv('aes-128-cbc', key, iv);
  cbc.setAutoPadding(false);
  const text = Buffer.concat([cbc.update(buf.subarray(BLOCK)), cbc.final()]).toString('latin1');
  const end = text.indexOf('\n');
  if (end < 0) return null;
  const answer = text.slice(0, end).replace(/\r$/, '');
  // A wrong keycode decrypts to noise.
  return /^[\x20-\x7e]*$/.test(answer) ? answer : null;
}

/** One connection to a TV, kept open for a while, one command at a time. */
class Client {
  constructor(address, { keycode = null } = {}) {
    this.address = address;
    this.keycode = keycode || null;
    this.socket = null;
    this.queue = Promise.resolve();
    this.idle = null;
    this.pending = null; // { buf, resolve, reject, timer }
  }

  _connect(timeoutMs) {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.address, port: PORTS.ipControl });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(httpError(504, `The TV at ${this.address} didn't answer`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve(socket);
      });
      socket.on('data', (chunk) => this._data(chunk));
      socket.on('error', (err) => {
        clearTimeout(timer);
        if (this.socket !== socket) {
          reject(httpError(502, err.code === 'ECONNREFUSED'
            ? `The TV at ${this.address} isn't taking IP control (port ${PORTS.ipControl} is closed). Turn on Network IP Control in its IP Control Setup menu.`
            : lan.unreachable(err) ? `The TV at ${this.address} didn't answer. Is it on and on the network?` : `Couldn't reach the TV at ${this.address}: ${err.message}`));
        }
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        this._fail(httpError(502, 'The TV closed the connection without answering. Is the keycode right?'));
      });
    });
  }

  _data(chunk) {
    const p = this.pending;
    if (!p) return;
    p.buf = Buffer.concat([p.buf, chunk]);
    let answer = null;
    if (this.keycode) answer = decrypt(p.buf, this.keycode);
    else if (p.buf.includes(0x0a)) answer = p.buf.toString('latin1').split('\n')[0].replace(/\r$/, '');
    if (answer === null) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(answer);
  }

  _fail(err) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  /** Sends one command; @returns the TV's answer ("OK", "VOL:12", …) */
  send(command, { timeoutMs = 4000 } = {}) {
    const run = async () => {
      const socket = await this._connect(timeoutMs);
      clearTimeout(this.idle);
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const got = this.pending?.buf.length || 0;
          this.pending = null;
          socket.destroy();
          reject(httpError(504, got
            ? 'The TV\'s answer didn\'t make sense. The keycode is probably wrong (it\'s case sensitive).'
            : 'The TV didn\'t answer the command. Is the keycode right?'));
        }, timeoutMs);
        this.pending = { buf: Buffer.alloc(0), resolve, reject, timer };
        socket.write(this.keycode ? encrypt(command, this.keycode) : Buffer.from(`${command}\r`, 'latin1'));
      });
      this.idle = setTimeout(() => this.close(), IDLE_MS);
      this.idle.unref?.();
      return answer;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  close() {
    clearTimeout(this.idle);
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }
}

module.exports = { PORTS, SALT, deriveKey, pad, encrypt, decrypt, Client };
