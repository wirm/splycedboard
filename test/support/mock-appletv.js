/**
 * Mock Apple TV (Companion protocol server side) for the test suite.
 *
 * Implements the TV's half of PIN pair-setup — with fast-srp-hap as an independent SRP
 * server — pair-verify, the encrypted session, and the requests SplycedBoard sends.
 * Records everything it receives so tests can assert on it.
 */
const net = require('net');
const crypto = require('crypto');
const { SRP, SrpServer } = require('fast-srp-hap');

const opack = require('../../SplycedBoard/src/integrations/appletv/companion/opack');
const { Tlv, encode: tlv, decode: untlv } = require('../../SplycedBoard/src/integrations/appletv/companion/tlv8');
const c = require('../../SplycedBoard/src/integrations/appletv/companion/crypto');
const { FrameType } = require('../../SplycedBoard/src/integrations/appletv/companion/connection');

const Hid = { Sleep: 12, Wake: 13 };
const Flags = { Play: 0x1, Pause: 0x2 };

function startMockAppleTv({ pin = '1234', answersAttention = true } = {}) {
  const atv = { id: Buffer.from(crypto.randomUUID()), keys: c.ed25519KeyPair() };
  const controllers = new Map(); // clientId → long-term public key
  const sessions = new Set();
  const state = {
    attention: 3, // awake
    mediaFlags: Flags.Play, // something paused
    apps: { 'com.netflix.Netflix': 'Netflix', 'com.apple.TVWatchList': 'TV' },
    pinShown: 0,
    requests: [], // every E_OPACK request { _i, _c }
    hid: [], // [code, 1 down | 2 up]
    mcc: [],
    launched: [],
    pairedNames: [],
  };

  class Session {
    constructor(socket) {
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      this.keys = null;
      this.subscribed = new Set();
      this.xid = 1;
      sessions.add(this);
      socket.on('data', (d) => this.onData(d));
      socket.on('close', () => sessions.delete(this));
      socket.on('error', () => {});
    }

    send(type, message) {
      const payload = opack.encode(message);
      const encrypt = this.keys && payload.length > 0;
      const length = payload.length + (encrypt ? 16 : 0);
      const header = Buffer.from([type, length >> 16, (length >> 8) & 0xff, length & 0xff]);
      const body = encrypt ? c.seal(this.keys.out, c.counterNonce(this.keys.outCounter++), payload, header) : payload;
      this.socket.write(Buffer.concat([header, body]));
    }

    onData(chunk) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUIntBE(1, 3);
        if (this.buffer.length < 4 + length) return;
        const header = Buffer.from(this.buffer.subarray(0, 4));
        let payload = Buffer.from(this.buffer.subarray(4, 4 + length));
        this.buffer = this.buffer.subarray(4 + length);
        if (this.keys && payload.length) payload = c.open(this.keys.in, c.counterNonce(this.keys.inCounter++), payload, header);
        this.handle(header[0], opack.decode(payload));
      }
    }

    handle(type, message) {
      if (type === FrameType.PS_Start) return this.setupM1(message);
      if (type === FrameType.PS_Next) return this.setupNext(message);
      if (type === FrameType.PV_Start) return this.verifyM1(message);
      if (type === FrameType.PV_Next) return this.verifyM3(message);
      if (type === FrameType.E_OPACK) return this.onMessage(message);
      return undefined;
    }

    reply(type, items) {
      this.send(type, { _pd: tlv(items) });
    }

    // ── Pair-setup ──────────────────────────────────────────────────────────

    setupM1(message) {
      const fields = untlv(message._pd);
      if (message._pwTy !== 1 || fields.get(Tlv.Method)?.[0] !== 0 || fields.get(Tlv.State)?.[0] !== 1) {
        return this.reply(FrameType.PS_Next, [[Tlv.State, [2]], [Tlv.Error, [1]]]);
      }
      const salt = crypto.randomBytes(16);
      this.srp = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from(pin), crypto.randomBytes(32));
      state.pinShown++;
      return this.reply(FrameType.PS_Next, [[Tlv.State, [2]], [Tlv.Salt, salt], [Tlv.PublicKey, this.srp.computeB()]]);
    }

    setupNext(message) {
      const fields = untlv(message._pd);
      const step = fields.get(Tlv.State)?.[0];

      if (step === 3) {
        this.srp.setA(fields.get(Tlv.PublicKey));
        try {
          this.srp.checkM1(fields.get(Tlv.Proof));
        } catch {
          return this.reply(FrameType.PS_Next, [[Tlv.State, [4]], [Tlv.Error, [2]]]); // wrong PIN
        }
        this.K = this.srp.computeK();
        return this.reply(FrameType.PS_Next, [[Tlv.State, [4]], [Tlv.Proof, this.srp.computeM2()]]);
      }

      if (step === 5) {
        const sessionKey = c.hkdf(this.K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
        const inner = untlv(c.open(sessionKey, c.labelNonce('PS-Msg05'), fields.get(Tlv.EncryptedData)));
        const clientId = inner.get(Tlv.Identifier);
        const clientKey = inner.get(Tlv.PublicKey);
        const controllerX = c.hkdf(this.K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
        if (!c.ed25519Verify(clientKey, Buffer.concat([controllerX, clientId, clientKey]), inner.get(Tlv.Signature))) {
          return this.reply(FrameType.PS_Next, [[Tlv.State, [6]], [Tlv.Error, [2]]]);
        }
        controllers.set(clientId.toString('hex'), clientKey);
        state.pairedNames.push(opack.decode(inner.get(Tlv.Name)).name);

        const accessoryX = c.hkdf(this.K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
        const signature = c.ed25519Sign(atv.keys.secret, Buffer.concat([accessoryX, atv.id, atv.keys.public]));
        const m6 = tlv([[Tlv.Identifier, atv.id], [Tlv.PublicKey, atv.keys.public], [Tlv.Signature, signature]]);
        return this.reply(FrameType.PS_Next, [[Tlv.State, [6]], [Tlv.EncryptedData, c.seal(sessionKey, c.labelNonce('PS-Msg06'), m6)]]);
      }
      return undefined;
    }

    // ── Pair-verify ─────────────────────────────────────────────────────────

    verifyM1(message) {
      const fields = untlv(message._pd);
      this.clientEphemeral = fields.get(Tlv.PublicKey);
      this.ephemeral = c.x25519KeyPair();
      this.shared = c.x25519Shared(this.ephemeral.secret, this.clientEphemeral);
      this.verifyKey = c.hkdf(this.shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
      const signature = c.ed25519Sign(atv.keys.secret, Buffer.concat([this.ephemeral.public, atv.id, this.clientEphemeral]));
      const inner = tlv([[Tlv.Identifier, atv.id], [Tlv.Signature, signature]]);
      return this.reply(FrameType.PV_Next, [
        [Tlv.State, [2]],
        [Tlv.PublicKey, this.ephemeral.public],
        [Tlv.EncryptedData, c.seal(this.verifyKey, c.labelNonce('PV-Msg02'), inner)],
      ]);
    }

    verifyM3(message) {
      const fields = untlv(message._pd);
      const inner = untlv(c.open(this.verifyKey, c.labelNonce('PV-Msg03'), fields.get(Tlv.EncryptedData)));
      const clientId = inner.get(Tlv.Identifier);
      const key = controllers.get(clientId.toString('hex'));
      const signed = Buffer.concat([this.clientEphemeral, clientId, this.ephemeral.public]);
      if (!key || !c.ed25519Verify(key, signed, inner.get(Tlv.Signature))) {
        return this.reply(FrameType.PV_Next, [[Tlv.State, [4]], [Tlv.Error, [2]]]);
      }
      this.reply(FrameType.PV_Next, [[Tlv.State, [4]]]);
      this.keys = {
        out: c.hkdf(this.shared, '', 'ServerEncrypt-main'),
        in: c.hkdf(this.shared, '', 'ClientEncrypt-main'),
        outCounter: 0,
        inCounter: 0,
      };
      return undefined;
    }

    // ── Session ─────────────────────────────────────────────────────────────

    onMessage(message) {
      const { _i: id, _t: kind, _c: content = {}, _x: xid } = message;
      if (kind === 1) {
        if (id === '_interest') for (const e of content._regEvents || []) this.subscribed.add(e);
        return;
      }
      state.requests.push({ _i: id, _c: content });
      const respond = (body = {}) => this.send(FrameType.E_OPACK, { _t: 3, _x: xid, _c: body });

      switch (id) {
        case '_sessionStart':
          return respond({ _sid: 0x2a });
        case '_hidC':
          state.hid.push([content._hidC, content._hBtS]);
          if (content._hBtS === 2 && content._hidC === Hid.Sleep) setAttention(1);
          if (content._hBtS === 2 && content._hidC === Hid.Wake) setAttention(3);
          return respond();
        case 'FetchAttentionState':
          if (!answersAttention) return this.send(FrameType.E_OPACK, { _t: 3, _x: xid, _em: 'Unsupported' });
          return respond({ state: state.attention });
        case 'FetchLaunchableApplicationsEvent':
          return respond(state.apps);
        case '_launchApp':
          state.launched.push(content._bundleID || content._urlS);
          return respond();
        case '_mcc':
          state.mcc.push(content._mcc);
          if (content._mcc === 1) setMediaFlags(Flags.Pause);
          if (content._mcc === 2) setMediaFlags(Flags.Play);
          return respond();
        default:
          return respond();
      }
    }

    event(id, content) {
      if (this.keys && this.subscribed.has(id)) this.send(FrameType.E_OPACK, { _i: id, _t: 1, _c: content, _x: this.xid++ });
    }
  }

  function setAttention(value) {
    state.attention = value;
    for (const s of sessions) s.event('SystemStatus', { state: value });
  }

  function setMediaFlags(flags) {
    state.mediaFlags = flags;
    for (const s of sessions) s.event('_iMC', { _mcF: flags });
  }

  const server = net.createServer((socket) => new Session(socket));

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      state,
      setAttention,
      setMediaFlags,
      /** Like removing SplycedBoard under Settings → Remotes and Devices on the TV. */
      forgetPairings: () => controllers.clear(),
      get connections() {
        return [...sessions].filter((s) => s.keys).length;
      },
      dropConnections() {
        for (const s of sessions) s.socket.destroy();
      },
      clearLog() {
        state.requests.length = 0;
        state.hid.length = 0;
        state.mcc.length = 0;
        state.launched.length = 0;
      },
      close() {
        for (const s of sessions) s.socket.destroy();
        return new Promise((r) => server.close(() => r()));
      },
    }));
  });
}

module.exports = { startMockAppleTv };
