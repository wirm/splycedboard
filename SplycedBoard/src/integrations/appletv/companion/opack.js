/**
 * OPACK — Apple's compact binary serialization, used for every Companion message.
 *
 * Encoding matches pyatv's (the reference open-source client, proven against real Apple
 * TVs) byte for byte, including back-references: a repeated multi-byte value is written
 * as 0xA0+index into the list of values seen so far in the message.
 *
 *   0x01/0x02 true/false · 0x04 null · 0x08–0x2F small int (value+8) · 0x30–0x33 int 1/2/4/8 B LE
 *   0x35/0x36 float32/64 LE · 0x40–0x60 short string · 0x61–0x64 string, 1–4 B length LE
 *   0x70–0x90 short bytes · 0x91–0x94 bytes, 1/2/4/8 B length LE
 *   0xD0–0xDF list (0xDF = open-ended, ends with 0x03) · 0xE0–0xEF dict (0xEF = open-ended)
 *   0xA0–0xC0 back-reference · 0xC1–0xC4 back-reference with a 1–4 B index
 */

/** Wrap a number that must be sent as a float even if it's whole (e.g. 1000.0). */
class OpackFloat {
  constructor(value) {
    this.value = value;
  }
}
const float = (value) => new OpackFloat(value);

// ── Encoding ─────────────────────────────────────────────────────────────────

function uint(value, bytes) {
  const b = Buffer.alloc(bytes);
  if (bytes === 8) b.writeBigUInt64LE(BigInt(value));
  else b.writeUIntLE(value, 0, bytes);
  return b;
}

function encodeInt(n) {
  if (n < 0x28) return Buffer.from([n + 8]);
  if (n <= 0xff) return Buffer.concat([Buffer.from([0x30]), uint(n, 1)]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0x31]), uint(n, 2)]);
  if (n <= 0xffffffff) return Buffer.concat([Buffer.from([0x32]), uint(n, 4)]);
  return Buffer.concat([Buffer.from([0x33]), uint(n, 8)]);
}

function encodeFloat(n) {
  const b = Buffer.alloc(9);
  b[0] = 0x36;
  b.writeDoubleLE(n, 1);
  return b;
}

function withLength(shortBase, longTags, lengthSizes, data) {
  if (data.length <= 0x20) return Buffer.concat([Buffer.from([shortBase + data.length]), data]);
  for (let i = 0; i < longTags.length; i++) {
    const size = lengthSizes[i];
    if (data.length < 2 ** (8 * size)) return Buffer.concat([Buffer.from([longTags[i]]), uint(data.length, size), data]);
  }
  throw new RangeError('OPACK value too long');
}

function pack(value, objects) {
  let out;
  if (value === null || value === undefined) out = Buffer.from([0x04]);
  else if (value === true) out = Buffer.from([0x01]);
  else if (value === false) out = Buffer.from([0x02]);
  else if (value instanceof OpackFloat) out = encodeFloat(value.value);
  else if (typeof value === 'bigint') {
    out = value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? encodeInt(Number(value))
      : Buffer.concat([Buffer.from([0x33]), uint(value, 8)]);
  } else if (typeof value === 'number') {
    out = Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? encodeInt(value) : encodeFloat(value);
  } else if (typeof value === 'string') {
    out = withLength(0x40, [0x61, 0x62, 0x63, 0x64], [1, 2, 3, 4], Buffer.from(value, 'utf8'));
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    out = withLength(0x70, [0x91, 0x92, 0x93, 0x94], [1, 2, 4, 8], Buffer.from(value));
  } else if (Array.isArray(value)) {
    const parts = [Buffer.from([0xd0 + Math.min(value.length, 0xf)])];
    for (const item of value) parts.push(pack(item, objects));
    if (value.length >= 0xf) parts.push(Buffer.from([0x03]));
    out = Buffer.concat(parts);
  } else if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const parts = [Buffer.from([0xe0 + Math.min(entries.length, 0xf)])];
    for (const [k, v] of entries) parts.push(pack(k, objects), pack(v, objects));
    if (entries.length >= 0xf) parts.push(Buffer.from([0x03]));
    out = Buffer.concat(parts);
  } else {
    throw new TypeError(`Cannot OPACK-encode ${typeof value}`);
  }

  // Back-references, exactly as pyatv does them: any multi-byte encoding seen before
  // (containers included) is replaced by its index.
  const index = objects.findIndex((o) => o.equals(out));
  if (index !== -1) return refBytes(index);
  if (out.length > 1) objects.push(out);
  return out;
}

function refBytes(index) {
  if (index <= 0x20) return Buffer.from([0xa0 + index]);
  for (let size = 1; size <= 4; size++) {
    if (index < 2 ** (8 * size)) return Buffer.concat([Buffer.from([0xc0 + size]), uint(index, size)]);
  }
  throw new RangeError('OPACK reference index too large');
}

function encode(value) {
  return pack(value, []);
}

// ── Decoding ─────────────────────────────────────────────────────────────────

const keyOf = (v) => (Buffer.isBuffer(v) ? `b:${v.toString('hex')}` : `${typeof v}:${v}`);

function decode(buf) {
  const objects = [];
  const seen = new Set();
  let pos = 0;

  const need = (n) => {
    if (pos + n > buf.length) throw new RangeError('Truncated OPACK data');
  };
  const take = (n) => {
    need(n);
    const out = buf.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const readUint = (n) => {
    const b = take(n);
    return n === 8 ? Number(b.readBigUInt64LE()) : b.readUIntLE(0, n);
  };
  // Values that later messages may reference (pyatv's rule: scalars that took >1 byte).
  const remember = (v) => {
    const k = keyOf(v);
    if (!seen.has(k)) {
      seen.add(k);
      objects.push(v);
    }
    return v;
  };

  function next() {
    need(1);
    const tag = buf[pos++];

    if (tag === 0x01) return true;
    if (tag === 0x02) return false;
    if (tag === 0x04) return null;
    if (tag === 0x05) {
      const h = take(16).toString('hex');
      return remember(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`);
    }
    if (tag === 0x06) return remember(take(8).readDoubleLE()); // absolute time
    if (tag >= 0x08 && tag <= 0x2f) return tag - 8;
    if (tag >= 0x30 && tag <= 0x33) return remember(readUint(2 ** (tag & 0x0f)));
    if (tag === 0x35) return remember(take(4).readFloatLE());
    if (tag === 0x36) return remember(take(8).readDoubleLE());
    if (tag >= 0x40 && tag <= 0x60) return remember(take(tag - 0x40).toString('utf8'));
    if (tag >= 0x61 && tag <= 0x64) return remember(take(readUint(tag - 0x60)).toString('utf8'));
    if (tag >= 0x70 && tag <= 0x90) return remember(Buffer.from(take(tag - 0x70)));
    if (tag >= 0x91 && tag <= 0x94) return remember(Buffer.from(take(readUint(1 << ((tag & 0x0f) - 1)))));
    if (tag >= 0xa0 && tag <= 0xc0) return ref(tag - 0xa0);
    if (tag >= 0xc1 && tag <= 0xc4) return ref(readUint(tag - 0xc0));

    if ((tag & 0xf0) === 0xd0) {
      const count = tag & 0x0f;
      const list = [];
      if (count === 0x0f) {
        while ((need(1), buf[pos]) !== 0x03) list.push(next());
        pos++;
      } else {
        for (let i = 0; i < count; i++) list.push(next());
      }
      return list;
    }

    if ((tag & 0xf0) === 0xe0) {
      const count = tag & 0x0f;
      const dict = {};
      const entry = () => {
        const k = next();
        dict[String(k)] = next();
      };
      if (count === 0x0f) {
        while ((need(1), buf[pos]) !== 0x03) entry();
        pos++;
      } else {
        for (let i = 0; i < count; i++) entry();
      }
      return dict;
    }

    throw new TypeError(`Unknown OPACK tag 0x${tag.toString(16)}`);
  }

  function ref(index) {
    if (index >= objects.length) throw new RangeError(`OPACK reference ${index} out of range`);
    return objects[index];
  }

  const value = next();
  return value;
}

module.exports = { encode, decode, float };
