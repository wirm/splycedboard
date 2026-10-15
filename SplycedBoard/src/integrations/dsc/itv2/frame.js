/**
 * ITv2 on the wire (DSC calls this layer TLink): each message is
 *
 *     <header> 7E <body> 7F
 *
 * The panel's header is its 12-character integration ID in ASCII; SplycedBoard sends the same
 * header back on every message. 7E separates header from body, 7F ends the message: there's
 * no start byte. Inside the header and the body, 7E, 7F and 7D are sent as 7D 01, 7D 02 and
 * 7D 00 (after encryption: the body may be AES ciphertext). Savant's own DSC profile declares
 * the same substitutions.
 */
const SEP = 0x7e;
const END = 0x7f;
const ESC = 0x7d;
const ESCAPED = { [ESC]: 0x00, [SEP]: 0x01, [END]: 0x02 };
const UNESCAPED = [ESC, SEP, END];
const MAX_BUFFER = 64 * 1024; // a peer that never sends an end byte doesn't get to grow memory forever

function escape(buf) {
  const out = [];
  for (const b of buf) {
    if (b in ESCAPED) out.push(ESC, ESCAPED[b]);
    else out.push(b);
  }
  return Buffer.from(out);
}

function unescape(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== ESC) {
      out.push(b);
      continue;
    }
    const code = buf[++i];
    if (code === undefined || code > 2) throw new Error(`Bad escape 7D ${code === undefined ? '(end)' : hex(code)}`);
    out.push(UNESCAPED[code]);
  }
  return Buffer.from(out);
}

/** The bytes to send for one message. */
function frame(body, header = Buffer.alloc(0)) {
  return Buffer.concat([escape(header), Buffer.from([SEP]), escape(body), Buffer.from([END])]);
}

/**
 * Splits a TCP stream back into messages: { header, body }, both unescaped. A message that
 * can't be read is reported through onError and skipped.
 */
class Deframer {
  constructor({ onError = () => {} } = {}) {
    this.buf = Buffer.alloc(0);
    this.onError = onError;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const messages = [];
    for (;;) {
      const end = this.buf.indexOf(END);
      if (end < 0) {
        if (this.buf.length > MAX_BUFFER) {
          this.onError(new Error(`No end byte in ${this.buf.length} bytes; dropped them`));
          this.buf = Buffer.alloc(0);
        }
        break;
      }
      const raw = this.buf.subarray(0, end);
      this.buf = this.buf.subarray(end + 1);
      const sep = raw.indexOf(SEP);
      if (sep < 0) {
        if (raw.length) this.onError(new Error(`No 7E separator in ${toHex(raw)}`));
        continue;
      }
      try {
        messages.push({ header: unescape(raw.subarray(0, sep)), body: unescape(raw.subarray(sep + 1)) });
      } catch (err) {
        this.onError(err);
      }
    }
    return messages;
  }
}

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection. Savant's profile
 * calls this checksum "crc_16_heatmiser" (Heatmiser's thermostats use the same one).
 */
function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const hex = (b) => b.toString(16).padStart(2, '0').toUpperCase();

/** "7E 01 02 …" for logs. */
function toHex(buf) {
  return [...buf].map(hex).join(' ');
}

module.exports = { SEP, END, ESC, escape, unescape, frame, Deframer, crc16, toHex };
