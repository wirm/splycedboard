/**
 * TLV8 — the type/length/value format inside pairing messages (the HAP pairing format).
 * Values longer than 255 bytes are split into consecutive items of the same type.
 */

const Tlv = {
  Method: 0x00,
  Identifier: 0x01,
  Salt: 0x02,
  PublicKey: 0x03,
  Proof: 0x04,
  EncryptedData: 0x05,
  State: 0x06,
  Error: 0x07,
  BackOff: 0x08,
  Signature: 0x0a,
  Name: 0x11,
};

const ERRORS = {
  0x01: 'The Apple TV reported an unknown pairing error',
  0x02: 'Wrong PIN',
  0x03: 'The Apple TV asked to wait before trying again',
  0x04: 'The Apple TV has too many paired devices',
  0x05: 'Too many pairing attempts — restart the Apple TV and try again',
  0x06: 'The Apple TV is not accepting pairing right now',
  0x07: 'The Apple TV is busy pairing with another device',
};

/** @param items  Array of [type, Buffer] in the order they should be written */
function encode(items) {
  const parts = [];
  for (const [type, value] of items) {
    const buf = Buffer.from(value);
    for (let pos = 0; pos < buf.length; pos += 255) {
      const chunk = buf.subarray(pos, pos + 255);
      parts.push(Buffer.from([type, chunk.length]), chunk);
    }
  }
  return Buffer.concat(parts);
}

/** → Map(type → Buffer), with fragments of the same type joined back together */
function decode(buf) {
  const out = new Map();
  let pos = 0;
  while (pos + 2 <= buf.length) {
    const type = buf[pos];
    const length = buf[pos + 1];
    const value = buf.subarray(pos + 2, pos + 2 + length);
    out.set(type, out.has(type) ? Buffer.concat([out.get(type), value]) : Buffer.from(value));
    pos += 2 + length;
  }
  return out;
}

/** Throw a readable error if a pairing response carries an error code. */
function throwIfError(tlv) {
  if (!tlv.has(Tlv.Error)) return;
  const code = tlv.get(Tlv.Error)[0];
  throw Object.assign(new Error(ERRORS[code] || `Pairing error ${code}`), { tlvError: code });
}

module.exports = { Tlv, encode, decode, throwIfError };
