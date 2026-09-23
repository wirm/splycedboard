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
 */
const tls = require('tls');
const { EventEmitter } = require('events');

const LEAP_PORT = 8081;
const PING_INTERVAL_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

class LeapClient extends EventEmitter {
  constructor(host, certOptions) {
    super();
    this.host = host;
    this.certOptions = certOptions; // { ca, cert, key }
    this.socket = null;
    this.buffer = '';
    this.pending = new Map(); // clientTag -> { resolve, reject, timer }
    this.tagCounter = 1;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.connected = false;
    this.destroyed = false;
  }

  connect() {
    if (this.destroyed) return;

    const opts = {
      host: this.host,
      port: LEAP_PORT,
      rejectUnauthorized: false,
    };

    if (this.certOptions?.cert) {
      opts.cert = this.certOptions.cert;
      opts.key = this.certOptions.key;
      if (this.certOptions.ca) opts.ca = this.certOptions.ca;
    }

    console.log(`[leap] Connecting to ${this.host}:${LEAP_PORT}...`);

    const socket = tls.connect(opts);
    this.socket = socket;

    socket.on('secureConnect', () => {
      console.log(`[leap] Connected to ${this.host}`);
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this._startPing();
      this.emit('connect');
    });

    socket.on('data', (data) => this._onData(data));

    socket.on('close', () => {
      this._onDisconnect('socket closed');
    });

    socket.on('error', (err) => {
      // error is followed by close, so just log it
      console.error(`[leap] Socket error: ${err.message}`);
    });

    socket.on('timeout', () => {
      socket.destroy();
    });

    socket.setTimeout(PING_INTERVAL_MS * 2);
  }

  _onData(data) {
    this.buffer += data.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop(); // incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._handleMessage(msg);
    }

    // Handle response with no trailing newline
    if (this.buffer.trim()) {
      try {
        JSON.parse(this.buffer);
        const line = this.buffer;
        this.buffer = '';
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        this._handleMessage(msg);
      } catch { /* incomplete */ }
    }
  }

  _handleMessage(msg) {
    const tag = msg.Header?.ClientTag;

    if (tag && this.pending.has(tag)) {
      const { resolve, reject, timer } = this.pending.get(tag);
      this.pending.delete(tag);
      clearTimeout(timer);

      const code = String(msg.Header?.StatusCode || '200');
      if (code.startsWith('2') || code === '0') {
        resolve(msg);
      } else {
        // Only log unexpected server errors; 4xx are expected probe failures handled by callers
        if (!code.startsWith('4')) {
          console.error(`[leap ←] error ${code} for tag ${tag}:`, JSON.stringify(msg.Body));
        }
        reject(new Error(`LEAP error ${code}: ${JSON.stringify(msg.Body)}`));
      }
    } else {
      // Unsolicited — subscription updates, etc.
      this.emit('message', msg);
    }
  }

  _onDisconnect(reason) {
    if (this.destroyed) return;
    console.warn(`[leap] Disconnected (${reason}). Reconnecting in ${this.reconnectDelay}ms...`);
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
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _send(msg) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected');
    }
    this.socket.write(JSON.stringify(msg) + '\r\n');
  }

  request(communiqueType, url, body = null) {
    return new Promise((resolve, reject) => {
      const tag = String(this.tagCounter++);

      const timer = setTimeout(() => {
        if (this.pending.has(tag)) {
          this.pending.delete(tag);
          reject(new Error(`LEAP request timeout: ${url}`));
        }
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(tag, { resolve, reject, timer });

      const msg = {
        CommuniqueType: communiqueType,
        Header: { ClientTag: tag, Url: url },
      };
      if (body) msg.Body = body;

      try {
        this._send(msg);
      } catch (err) {
        this.pending.delete(tag);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  subscribe(url) {
    return this.request('SubscribeRequest', url);
  }

  destroy() {
    this.destroyed = true;
    this._stopPing();
    clearTimeout(this.reconnectTimer);
    this._rejectAllPending(new Error('Client destroyed'));
    this.socket?.destroy();
  }
}

module.exports = { LeapClient };
