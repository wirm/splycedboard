/**
 * Low-level Lutron LEAP protocol client.
 *
 * Handles:
 *  - TLS connection to the processor (port 8081)
 *  - Newline-delimited JSON message framing
 *  - Request/response correlation via ClientTag
 *  - Unsolicited message (subscription) routing via events
 *  - Automatic reconnection with exponential backoff
 *  - Keepalive pings every 60s
 *
 * Events: 'connect', 'disconnect', 'message' (unsolicited LEAP message)
 */
const tls = require('tls');
const { EventEmitter } = require('events');

const LEAP_PORT = 8081;
const PING_INTERVAL_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

class LeapClient extends EventEmitter {
  /**
   * @param host         processor IP / hostname
   * @param certOptions  { ca, cert, key } from pairing
   * @param opts         { port, log }
   */
  constructor(host, certOptions, { port = LEAP_PORT, log } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.certOptions = certOptions;
    this.log = log;
    this.socket = null;
    this.buffer = '';
    this.pending = new Map(); // clientTag → { resolve, reject, timer }
    this.tagCounter = 1;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.connected = false;
    this.destroyed = false;
  }

  connect() {
    if (this.destroyed) return;

    const opts = { host: this.host, port: this.port, rejectUnauthorized: false };
    if (this.certOptions?.cert) {
      opts.cert = this.certOptions.cert;
      opts.key = this.certOptions.key;
      if (this.certOptions.ca) opts.ca = this.certOptions.ca;
    }

    this.log.info(`Connecting to ${this.host}:${this.port}...`);
    this.buffer = '';

    const socket = tls.connect(opts);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(PING_INTERVAL_MS * 2);

    socket.on('secureConnect', () => {
      this.log.info(`Connected to ${this.host}`);
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this._startPing();
      this.emit('connect');
    });
    socket.on('data', (data) => this._onData(data));
    socket.on('close', () => this._onDisconnect('socket closed'));
    // 'error' is always followed by 'close', which handles the reconnect.
    socket.on('error', (err) => this.log.error(`Socket error: ${err.message}`));
    socket.on('timeout', () => socket.destroy());
  }

  _onData(data) {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop(); // incomplete trailing line
    for (const line of lines) this._parseLine(line);

    // Some responses arrive without a trailing newline.
    if (this.buffer.trim() && this._parseLine(this.buffer)) this.buffer = '';
  }

  _parseLine(line) {
    if (!line.trim()) return false;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return false;
    }
    this._handleMessage(msg);
    return true;
  }

  _handleMessage(msg) {
    const tag = msg.Header?.ClientTag;

    if (!tag || !this.pending.has(tag)) {
      this.emit('message', msg); // unsolicited: subscription updates etc.
      return;
    }

    const { resolve, reject, timer } = this.pending.get(tag);
    this.pending.delete(tag);
    clearTimeout(timer);

    const code = String(msg.Header?.StatusCode || '200');
    if (code.startsWith('2') || code === '0') {
      resolve(msg);
    } else {
      // 4xx are expected probe failures (e.g. QSX answering 405 to /zone) handled by callers.
      if (!code.startsWith('4')) this.log.error(`← error ${code} for tag ${tag}:`, JSON.stringify(msg.Body));
      reject(new Error(`LEAP error ${code}: ${JSON.stringify(msg.Body)}`));
    }
  }

  _onDisconnect(reason) {
    if (this.destroyed) return;
    this.log.warn(`Disconnected (${reason}). Reconnecting in ${this.reconnectDelay}ms...`);
    this.connected = false;
    this._stopPing();
    this._rejectAllPending(new Error('Disconnected'));
    this.emit('disconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.connect();
    }, this.reconnectDelay);
  }

  _rejectAllPending(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      this.request('ReadRequest', '/server/1/status/ping').catch(() => {});
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  request(communiqueType, url, body = null) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected'));
        return;
      }

      const tag = String(this.tagCounter++);
      const timer = setTimeout(() => {
        if (this.pending.delete(tag)) reject(new Error(`LEAP request timeout: ${url}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(tag, { resolve, reject, timer });

      const msg = { CommuniqueType: communiqueType, Header: { ClientTag: tag, Url: url } };
      if (body) msg.Body = body;
      this.socket.write(JSON.stringify(msg) + '\r\n');
    });
  }

  subscribe(url) {
    return this.request('SubscribeRequest', url);
  }

  destroy() {
    this.destroyed = true;
    this.connected = false;
    this._stopPing();
    clearTimeout(this.reconnectTimer);
    this._rejectAllPending(new Error('Client destroyed'));
    this.socket?.destroy();
  }
}

module.exports = { LeapClient, LEAP_PORT };
