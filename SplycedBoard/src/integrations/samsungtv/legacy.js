/**
 * The remote protocol of Samsung's pre-Tizen TVs (2010–2015 C, D, E, F and H series, and
 * some J): TCP port 55000. The first time, the TV asks whether to allow the remote; after
 * that it remembers it by the id it sent.
 *
 * A packet: 0x00, the app name (2-byte little-endian length + text), the payload (length +
 * bytes). Strings in the payload are base64, each with a 2-byte length.
 *
 *   send(address, key, identity)   authenticates, sends one key ("KEY_VOLUP"), closes
 *   pair(address, identity)        authenticates only: waits for Allow on the TV
 */
const net = require('net');

const lan = require('../../core/lan');

const PORTS = { legacy: 55000 };
const APP = 'iphone..iapp.samsung';
const TV_APP = 'iphone.UN60D6000.iapp.samsung';

const httpError = (status, message) => Object.assign(new Error(message), { status });

function lengthPrefixed(buf) {
  const len = Buffer.alloc(2);
  len.writeUInt16LE(buf.length);
  return Buffer.concat([len, buf]);
}

const b64 = (s) => lengthPrefixed(Buffer.from(Buffer.from(String(s)).toString('base64')));

function packet(app, payload) {
  return Buffer.concat([Buffer.from([0x00]), lengthPrefixed(Buffer.from(app)), lengthPrefixed(payload)]);
}

/** identity: { description (our IP), id (a MAC-like id the TV remembers), name } */
const authPacket = ({ description, id, name }) => packet(APP, Buffer.concat([Buffer.from([0x64, 0x00]), b64(description), b64(id), b64(name)]));
const keyPacket = (key) => packet(TV_APP, Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), b64(key)]));

/** Splits the TV's replies: 0x00|0x01|0x02, app name, payload. */
function* replies(buf) {
  let i = 0;
  while (buf.length - i >= 3) {
    const appLen = buf.readUInt16LE(i + 1);
    if (buf.length - i < 3 + appLen + 2) return;
    const payloadLen = buf.readUInt16LE(i + 3 + appLen);
    const end = i + 3 + appLen + 2 + payloadLen;
    if (buf.length < end) return;
    yield { payload: buf.subarray(i + 3 + appLen + 2, end), end };
    i = end;
  }
}

/**
 * Connects and authenticates, then runs `then(socket)` if given.
 * The TV answers 0x64 0x00 0x01 0x00 for allowed, 0x64 0x00 0x00 0x00 for denied, 0x0a …
 * while it waits for someone to answer, and 0x65 … when the question was dismissed.
 */
function session(address, identity, { timeoutMs = 5000, then = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port: PORTS.legacy });
    let buf = Buffer.alloc(0);
    let consumed = 0;
    let authed = false;
    let timer = null;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(httpError(504, authed ? 'The TV didn\'t confirm the key' : 'Nobody picked Allow on the TV in time')), ms);
    };
    const finish = (err, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    arm(timeoutMs);
    socket.on('connect', () => socket.write(authPacket(identity)));
    socket.on('error', (err) => finish(httpError(502, err.code === 'ECONNREFUSED'
      ? `The TV at ${address} isn't taking remote connections (port ${PORTS.legacy})`
      : lan.unreachable(err) ? `The TV at ${address} didn't answer. Is it on and on the network?` : `Couldn't reach the TV at ${address}: ${err.message}`)));
    socket.on('close', () => finish(httpError(502, 'The TV closed the connection')));
    socket.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const complete = [...replies(buf.subarray(consumed))];
      if (complete.length) consumed += complete[complete.length - 1].end;
      for (const { payload } of complete) {
        const p = [...payload.subarray(0, 4)];
        if (!authed) {
          if (p[0] === 0x64 && p[2] === 0x01) {
            authed = true;
            if (!then) {
              finish(null, true);
              return;
            }
            arm(timeoutMs);
            try {
              await then(socket);
            } catch (err) {
              finish(err);
              return;
            }
          } else if (p[0] === 0x64 && p[2] === 0x00) {
            finish(httpError(403, 'The TV turned SplycedBoard down'));
            return;
          } else if (p[0] === 0x65) {
            finish(httpError(403, 'The question on the TV was dismissed'));
            return;
          } else if (p[0] === 0x0a) {
            arm(45000); // it's asking on screen; give the viewer time
          }
        } else if (p[0] === 0x00) {
          finish(null, true); // key accepted
          return;
        }
      }
    });
  });
}

function pair(address, identity) {
  return session(address, identity, { timeoutMs: 45000 });
}

function send(address, key, identity) {
  return session(address, identity, { then: (socket) => socket.write(keyPacket(key)) });
}

module.exports = { PORTS, pair, send, authPacket, keyPacket, replies };
