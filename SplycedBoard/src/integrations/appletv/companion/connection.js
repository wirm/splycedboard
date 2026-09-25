/**
 * Companion protocol framing over TCP.
 *
 * Every frame is a 4-byte header — 1 byte frame type + 3 bytes big-endian payload
 * length — followed by the payload. After pair-verify, payloads are encrypted with
 * ChaCha20-Poly1305 (header as additional data, per-direction message counter as nonce),
 * and the length includes the 16-byte tag.
 *
 * Events: 'frame' (type, payload), 'close' (reason)
 */
const net = require('net');
const { EventEmitter } = require('events');

const { seal, open, counterNonce } = require('./crypto');

const FrameType = {
  NoOp: 1,
  PS_Start: 3,
  PS_Next: 4,
  PV_Start: 5,
  PV_Next: 6,
  U_OPACK: 7,
  E_OPACK: 8,
  P_OPACK: 9,
};

const HEADER_LENGTH = 4;
const TAG_LENGTH = 16;

class CompanionConnection extends EventEmitter {
  constructor({ host, port }) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.keys = null; // { out, in, outCounter, inCounter }
    this.closed = false;
  }

  connect({ timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      const fail = (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(Object.assign(new Error(`Timed out connecting to ${this.host}:${this.port}`), { code: 'ETIMEDOUT' }));
      }, timeoutMs);

      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 15000);
        socket.on('error', (err) => this._close(err.message));
        socket.on('close', () => this._close('connection closed'));
        socket.on('data', (chunk) => this._onData(chunk));
        resolve();
      });
    });
  }

  enableEncryption(outKey, inKey) {
    this.keys = { out: outKey, in: inKey, outCounter: 0, inCounter: 0 };
  }

  get encrypted() {
    return !!this.keys;
  }

  send(frameType, payload = Buffer.alloc(0)) {
    if (this.closed || !this.socket) throw new Error('Not connected');
    const encrypt = this.keys && payload.length > 0;
    const length = payload.length + (encrypt ? TAG_LENGTH : 0);
    const header = Buffer.from([frameType, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
    const body = encrypt ? seal(this.keys.out, counterNonce(this.keys.outCounter++), payload, header) : payload;
    this.socket.write(Buffer.concat([header, body]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_LENGTH) {
      const length = this.buffer.readUIntBE(1, 3);
      if (this.buffer.length < HEADER_LENGTH + length) return;

      const header = Buffer.from(this.buffer.subarray(0, HEADER_LENGTH));
      let payload = Buffer.from(this.buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + length));
      this.buffer = this.buffer.subarray(HEADER_LENGTH + length);

      if (this.keys && payload.length > 0) {
        try {
          payload = open(this.keys.in, counterNonce(this.keys.inCounter++), payload, header);
        } catch {
          this._close('could not decrypt data from the Apple TV');
          return;
        }
      }
      this.emit('frame', header[0], payload);
    }
  }

  _close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.emit('close', reason);
  }

  close() {
    this._close('closed');
  }
}

module.exports = { CompanionConnection, FrameType };
