/**
 * Companion protocol client — the protocol the iPhone "Remote" uses to control an
 * Apple TV. Pairing uses a PIN shown on the TV; HomeKit is not involved.
 *
 * Messages are OPACK dictionaries:
 *   { _i: 'identifier', _t: 1 event | 2 request | 3 response, _c: { content }, _x: transaction id }
 *
 * Events: 'event' (identifier, content), 'close' (reason)
 */
const { EventEmitter } = require('events');

const opack = require('./opack');
const { CompanionConnection, FrameType } = require('./connection');
const { randomBytes } = require('./crypto');

const MessageType = { Event: 1, Request: 2, Response: 3 };
const AUTH_RESPONSE_FRAMES = new Set([FrameType.PS_Next, FrameType.PV_Next]);
const OPACK_FRAMES = new Set([FrameType.U_OPACK, FrameType.E_OPACK, FrameType.P_OPACK]);

class CompanionClient extends EventEmitter {
  constructor({ host, port, log }) {
    super();
    this.host = host;
    this.port = port;
    this.log = log;
    this.connection = null;
    this.xid = randomBytes(2).readUInt16BE();
    this.pending = new Map(); // xid → { resolve, reject, timer }
    this.authWaiter = null;
    this.closed = false;
  }

  async open({ timeoutMs = 5000 } = {}) {
    const connection = new CompanionConnection({ host: this.host, port: this.port });
    this.connection = connection;
    connection.on('frame', (type, payload) => this._onFrame(type, payload));
    connection.on('close', (reason) => this._onClose(reason));
    await connection.connect({ timeoutMs });
  }

  get connected() {
    return !!this.connection && !this.connection.closed && !this.closed;
  }

  enableEncryption(outKey, inKey) {
    this.connection.enableEncryption(outKey, inKey);
  }

  // ── Pairing frames ─────────────────────────────────────────────────────────

  /** Send a pairing frame and wait for the Apple TV's next pairing frame. */
  exchangeAuth(frameType, message, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.authWaiter) {
        reject(new Error('A pairing step is already in progress'));
        return;
      }
      const timer = setTimeout(() => {
        this.authWaiter = null;
        reject(new Error('The Apple TV did not answer the pairing request'));
      }, timeoutMs);
      this.authWaiter = { resolve, reject, timer };
      try {
        this.connection.send(frameType, opack.encode(message));
      } catch (err) {
        clearTimeout(timer);
        this.authWaiter = null;
        reject(err);
      }
    });
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  /** Send a request and resolve with the response content (`_c`). */
  request(identifier, content = {}, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      const xid = this._nextXid();
      const timer = setTimeout(() => {
        if (this.pending.delete(xid)) reject(Object.assign(new Error(`${identifier}: no response`), { timeout: true }));
      }, timeoutMs);
      this.pending.set(xid, { resolve, reject, timer, identifier });
      try {
        this.connection.send(FrameType.E_OPACK, opack.encode({ _i: identifier, _t: MessageType.Request, _c: content, _x: xid }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(xid);
        reject(err);
      }
    });
  }

  /** Fire-and-forget event (e.g. subscribing to state changes). */
  sendEvent(identifier, content = {}) {
    this.connection.send(FrameType.E_OPACK, opack.encode({ _i: identifier, _t: MessageType.Event, _c: content, _x: this._nextXid() }));
  }

  _nextXid() {
    const xid = this.xid;
    this.xid = (this.xid + 1) % 0x10000;
    return xid;
  }

  _onFrame(type, payload) {
    let message;
    try {
      message = payload.length ? opack.decode(payload) : {};
    } catch (err) {
      this.log?.debug(`Ignoring undecodable frame type ${type}: ${err.message}`);
      return;
    }

    if (AUTH_RESPONSE_FRAMES.has(type)) {
      const waiter = this.authWaiter;
      if (!waiter) return;
      this.authWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    if (!OPACK_FRAMES.has(type)) return; // NoOp and friends

    if (message._t === MessageType.Response) {
      const entry = this.pending.get(message._x);
      if (!entry) return;
      this.pending.delete(message._x);
      clearTimeout(entry.timer);
      if (message._em) entry.reject(new Error(`${entry.identifier}: ${message._em}`));
      else entry.resolve(message._c || {});
      return;
    }

    if (message._t === MessageType.Event) {
      this.emit('event', message._i, message._c || {});
      return;
    }

    this.log?.debug(`Ignoring request from Apple TV: ${message._i}`);
  }

  _onClose(reason) {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`Connection closed (${reason})`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    if (this.authWaiter) {
      clearTimeout(this.authWaiter.timer);
      this.authWaiter.reject(err);
      this.authWaiter = null;
    }
    this.emit('close', reason);
  }

  close() {
    this.connection?.close();
    this._onClose('closed');
  }
}

module.exports = { CompanionClient, FrameType, MessageType };
