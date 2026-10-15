/**
 * Opening an ITv2 session, and its encryption. The panel's communicator dials in and leads:
 *
 *    panel                                  SplycedBoard
 *    Open Session (060A), in the clear  →
 *                                       ←   CommandResponse: OK
 *    Simple Ack                         →
 *                                       ←   Open Session: the panel's own, echoed
 *    CommandResponse: OK                →
 *                                       ←   Simple Ack
 *    Request Access (060E): its key     →   (from here we encrypt with the panel's key)
 *                                       ←   CommandResponse: OK, encrypted
 *    Simple Ack, in the clear           →
 *                                       ←   Request Access: our key
 *    CommandResponse: OK, encrypted     →   (from here we decrypt with our key)
 *                                       ←   Simple Ack — the session is open
 *
 * Encryption is AES-128-ECB, zero-padded, a key each way. The panel picks the type in its Open
 * Session ([425] option 4 on the communicator):
 *   Type 1: our static key is the access code's first 8 hex digits four times over, the
 *           panel's the integration ID's; each Request Access carries 16 check bytes in the
 *           clear, then 32 random bytes encrypted with the sender's static key. The odd bytes
 *           of those 32 are the session key, the even ones must equal the check bytes.
 *   Type 2: one static key, the 32-hex access code; each Request Access carries 16 random
 *           bytes, and the session key is those bytes encrypted with the static key.
 * The key the panel sends is the one we encrypt with; the one we send, the one it encrypts
 * with. (From the open-source servers NeoHub, LawPaul's dsc-itv2 and dsc-itv2-client, and
 * real captures; Savant's ITv2 plugin logs the same "own"/"peer" session keys.)
 */
const crypto = require('crypto');

const { name } = require('./codes');

const LEGACY_OPEN_SESSION = 14; // body bytes after the command sequence
const DECLINE = 0x18; // "internal error": how JCI's cloud turns down an encryption type it won't use

/** null when the settings can be used, else what's wrong with them. */
function validateCredentials(integrationId, accessCode) {
  if (!integrationId) return 'Enter the integration identification number (section [422])';
  if (!/^[0-9A-Fa-f]{12}$/.test(integrationId)) return 'The integration identification number is 12 characters, digits (or A–F)';
  if (!accessCode) return 'Enter the integration access code';
  if (!/^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32})$/.test(accessCode)) return 'The integration access code is 8 hex digits (type 1) or 32 (type 2)';
  return null;
}

/** "12345678" → 12 34 56 78 × 4: the first 8 hex digits, four times. */
const type1Key = (s) => Buffer.from(String(s).slice(0, 8).repeat(4), 'hex');
/** 32 hex digits as they are; 8 are repeated four times, as the factory default is. */
const type2Key = (s) => Buffer.from(s.length === 8 ? s.repeat(4) : s, 'hex');

class Handshake {
  constructor({ integrationId, accessCode, random = crypto.randomBytes }) {
    this.integrationId = integrationId;
    this.accessCode = accessCode;
    this.random = random;
    this.reset();
  }

  reset() {
    this.step = 'wait-open'; // wait-open → wait-open-ack → wait-open-response → wait-access → wait-access-ack → wait-access-response → ready
    this.type = null;
    this.panelOpen = null; // the panel's Open Session body, to echo
    this.txKey = null; // what we encrypt with (the panel's session key)
    this.rxKey = null; // what we decrypt with (ours)
  }

  get ready() {
    return this.step === 'ready';
  }

  describe() {
    if (this.ready) return `AES-128-ECB, type ${this.type}`;
    return this.step === 'wait-open' ? 'Not yet' : `Opening (type ${this.type ?? '?'})`;
  }

  /**
   * One packet from the panel while the session opens. Returns what to do, in order:
   *   { replies: [{ type: 'respond', code } | { type: 'ack' } | { type: 'send', cmd, payload }],
   *     description, ready?, failed? }
   * 'respond' and 'ack' answer this packet; 'send' starts a new command (with a command sequence).
   */
  receive(p) {
    const replies = [];
    const respond = (code = 0) => replies.push({ type: 'respond', code });
    const ack = () => replies.push({ type: 'ack' });

    if (p.cmd === 0x060a) {
      // An Open Session always starts over, even mid-session.
      this.reset();
      const body = p.payload;
      const type = body[LEGACY_OPEN_SESSION - 1];
      const offered = `device ${hex(body.subarray(0, 3))}, firmware ${hex(body.subarray(3, 5), '.')}, protocol ${hex(body.subarray(5, 7))}, encryption type ${type}`;
      if (body.length !== LEGACY_OPEN_SESSION || ![1, 2].includes(type)) {
        respond(DECLINE);
        return { replies, description: `Open Session from the panel (${offered}, ${body.length} bytes): declined, waiting for type 1 or 2` };
      }
      this.type = type;
      this.panelOpen = Buffer.from(body);
      respond();
      this.step = 'wait-open-ack';
      return { replies, description: `Open Session from the panel: ${offered}` };
    }

    switch (this.step) {
      case 'wait-open-ack':
        if (p.cmd != null) break;
        this.step = 'wait-open-response';
        replies.push({ type: 'send', cmd: 0x060a, payload: this.panelOpen, describe: 'Open Session (the panel\'s, echoed)' });
        return { replies, description: 'Ack' };

      case 'wait-open-response':
        if (p.cmd === 0x0502) {
          const code = p.payload[1];
          ack();
          if (code !== 0) return { replies, description: `Open Session refused (code ${code})`, failed: `The panel refused our Open Session (code ${code})` };
          this.step = 'wait-access';
          return { replies, description: 'Open Session accepted' };
        }
        if (p.cmd === 0x0501) {
          ack();
          return { replies, description: 'Open Session rejected', failed: `The panel rejected our Open Session (error ${p.payload[2]})` };
        }
        break;

      case 'wait-access':
        if (p.cmd !== 0x060e) break;
        try {
          this.txKey = this._panelSessionKey(lengthPrefixed(p.payload));
        } catch (err) {
          respond(DECLINE);
          return { replies, description: 'Request Access from the panel: unreadable', failed: err.message };
        }
        respond(); // the first encrypted message
        this.step = 'wait-access-ack';
        return { replies, description: `Request Access from the panel: its key checks out (type ${this.type})` };

      case 'wait-access-ack': {
        if (p.cmd != null) break;
        const { initializer, key } = this._ourInitializer();
        replies.push({ type: 'send', cmd: 0x060e, payload: Buffer.concat([Buffer.from([initializer.length]), initializer]), describe: 'Request Access (our key)' });
        this.rxKey = key; // the panel encrypts its answer with it
        this.step = 'wait-access-response';
        return { replies, description: 'Ack' };
      }

      case 'wait-access-response':
        if (p.cmd === 0x0502) {
          const code = p.payload[1];
          ack();
          if (code !== 0) return { replies, description: `Request Access refused (code ${code})`, failed: `The panel refused our Request Access (code ${code}): check the access code` };
          this.step = 'ready';
          return { replies, description: 'Request Access accepted: the session is open', ready: true };
        }
        break;

      default:
        break;
    }
    // Anything else while opening: answer it and carry on.
    if (p.cmd == null) return { replies, description: 'Ack' };
    if (p.appSeq != null) respond();
    else ack();
    return { replies, description: `${name(p.cmd)} while opening the session` };
  }

  /** The key the panel sent: what we encrypt with from now on. */
  _panelSessionKey(init) {
    if (this.type === 1) {
      if (init.length !== 48) throw new Error(`Type 1 Request Access should carry 48 bytes, not ${init.length}`);
      const plain = aesEcb('decrypt', type1Key(this.integrationId), init.subarray(16));
      if (!init.subarray(0, 16).equals(evenBytes(plain))) {
        throw new Error("The panel's key doesn't check out: the integration ID (or access code) doesn't match the panel's");
      }
      return oddBytes(plain);
    }
    if (init.length !== 16) throw new Error(`Type 2 Request Access should carry 16 bytes, not ${init.length}`);
    return aesEcb('encrypt', type2Key(this.accessCode), init);
  }

  /** Our Request Access: what we send, and the key the panel will encrypt with. */
  _ourInitializer() {
    if (this.type === 1) {
      const r = this.random(32);
      return { initializer: Buffer.concat([evenBytes(r), aesEcb('encrypt', type1Key(this.accessCode), r)]), key: oddBytes(r) };
    }
    const l = this.random(16);
    return { initializer: l, key: aesEcb('encrypt', type2Key(this.accessCode), l) };
  }

  encrypt(plain) {
    return this.txKey ? aesEcb('encrypt', this.txKey, pad16(plain)) : plain;
  }

  /**
   * A message's body, decrypted once we decrypt. Not whole AES blocks: it was sent in the clear
   * (the panel starting over with a new Open Session, or an ack sent just before it switched).
   */
  decrypt(body) {
    if (!this.rxKey || body.length % 16) return body;
    return aesEcb('decrypt', this.rxKey, body);
  }
}

function lengthPrefixed(buf) {
  const len = buf[0];
  if (len == null || buf.length < 1 + len) throw new Error(`Request Access too short (${buf.length} bytes)`);
  return buf.subarray(1, 1 + len);
}

const evenBytes = (buf) => Buffer.from([...buf].filter((_, i) => i % 2 === 0));
const oddBytes = (buf) => Buffer.from([...buf].filter((_, i) => i % 2 === 1));
const hex = (buf, sep = '') => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(sep);

function pad16(buf) {
  const extra = (16 - (buf.length % 16)) % 16;
  return extra ? Buffer.concat([buf, Buffer.alloc(extra)]) : buf;
}

function aesEcb(direction, key, data) {
  const c = direction === 'encrypt' ? crypto.createCipheriv('aes-128-ecb', key, null) : crypto.createDecipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

module.exports = { Handshake, validateCredentials, type1Key, type2Key, aesEcb, pad16, evenBytes, oddBytes };
