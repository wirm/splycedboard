/**
 * Samsung Smart View: the remote-control WebSocket of Tizen TVs (2016 and newer), the one
 * Samsung's phone remote uses.
 *
 *   info(address)                  the TV's own description (http://…:8001/api/v2/): model,
 *                                  name, model-year code ("18_KANTM2_FRAME"), MAC, power state
 *   pair(address, { secure })      connects without a token; the TV shows Allow/Deny for
 *                                  "SplycedBoard" and, on Allow, hands out a token
 *   Session                        one connection kept open while it's in use, for key presses
 *
 * 2017 and newer TVs (TokenAuthSupport) use port 8002 (TLS, self-signed) and a token; 2016
 * models use port 8001 and remember the Allow instead.
 */
const WebSocket = require('ws');

const lan = require('../../core/lan');

const PORTS = { api: 8001, secure: 8002 };
const NAME = Buffer.from('SplycedBoard').toString('base64');
const IDLE_MS = 60 * 1000;
const PAIR_TIMEOUT_MS = 45 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** The TV's description, or null when nothing answers there. */
async function info(address, { timeoutMs = 2000 } = {}) {
  try {
    const res = await lan.request(`http://${address}:${PORTS.api}/api/v2/`, { timeoutMs });
    return res.status === 200 && res.json?.device ? res.json : null;
  } catch {
    return null;
  }
}

function url(address, { secure, token }) {
  const port = secure ? PORTS.secure : PORTS.api;
  return `${secure ? 'wss' : 'ws'}://${address}:${port}/api/v2/channels/samsung.remote.control?name=${NAME}`
    + (token ? `&token=${encodeURIComponent(token)}` : '');
}

/**
 * Opens the remote channel and waits for the TV to let us in.
 * @returns { socket, token } — token: what the TV handed out (2017+), or null
 */
function open(address, { secure = true, token = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    // Both spellings: the ws package reads rejectUnauthorized, Bun's WebSocket reads tls.
    const socket = new WebSocket(url(address, { secure, token }), { rejectUnauthorized: false, tls: { rejectUnauthorized: false } });
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { socket.terminate?.() ?? socket.close(); } catch { /* already closed */ }
        reject(err);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(httpError(504, 'The TV didn\'t answer in time. If it asked about "SplycedBoard", Allow must be picked within 30 seconds.')), timeoutMs);
    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.event === 'ms.channel.connect') finish(null, { socket, token: msg.data?.token ? String(msg.data.token) : null });
      else if (msg.event === 'ms.channel.unauthorized') finish(httpError(403, 'The TV turned SplycedBoard down (Deny was picked, or it doesn\'t allow new remotes).'));
      else if (msg.event === 'ms.channel.timeOut') finish(httpError(504, 'Nobody picked Allow on the TV in time.'));
    });
    socket.on('error', (err) => finish(httpError(502, lan.unreachable(err)
      ? `The TV at ${address} didn't answer. Is it on and on the network?`
      : `Couldn't reach the TV's remote channel: ${err.message}`)));
    socket.on('close', () => finish(httpError(502, 'The TV closed the connection before letting SplycedBoard in.')));
  });
}

/** Asks the TV to allow SplycedBoard. @returns the token (null on 2016 models) */
async function pair(address, { secure = true } = {}) {
  const { socket, token } = await open(address, { secure, timeoutMs: PAIR_TIMEOUT_MS });
  try { socket.close(); } catch { /* already closed */ }
  return token;
}

/** A remote-control connection that stays open while keys are being pressed. */
class Session {
  constructor(address, { secure, token }) {
    this.address = address;
    this.secure = secure;
    this.token = token;
    this.socket = null;
    this.opening = null;
    this.idle = null;
  }

  async _socket() {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (!this.opening) {
      this.opening = open(this.address, { secure: this.secure, token: this.token })
        .then(({ socket }) => {
          this.socket = socket;
          socket.on('close', () => { if (this.socket === socket) this.socket = null; });
          socket.on('error', () => {});
          return socket;
        })
        .finally(() => { this.opening = null; });
    }
    return this.opening;
  }

  _touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  /** Cmd: 'Click' | 'Press' | 'Release' */
  async key(key, cmd = 'Click') {
    const socket = await this._socket();
    socket.send(JSON.stringify({
      method: 'ms.remote.control',
      params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    }));
    this._touch();
  }

  close() {
    clearTimeout(this.idle);
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* already closed */ }
  }
}

module.exports = { PORTS, info, open, pair, Session };
