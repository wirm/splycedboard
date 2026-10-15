/**
 * One ITv2 packet: what travels inside a frame (and, once the session is encrypted, inside the
 * encryption):
 *
 *     [length] [sequence] [ack] [command: 2] [app sequence] [payload…] [CRC-16: 2]
 *
 *   length    how many bytes follow it, the CRC included: one byte, or two with the top bit
 *             set (80 nn) once there are more than 127
 *   sequence  this side's packet counter, one byte, wrapping
 *   ack       the last sequence received from the other side
 *   command   absent in a bare acknowledgement: [04] [sequence] [ack] [CRC]
 *   app seq   only in commands that get a CommandResponse (0502) back, which names it
 *   CRC       CRC-16/CCITT-FALSE over everything before it, big-endian
 *
 * The lengths of the commands in Savant's own DSC profile check out against this layout
 * (Open Session 15 = 21 bytes after the length, Arm 0C, Disarm 0B, Poll 06, ack 04).
 */
const { crc16 } = require('./frame');

// Commands carrying an app sequence: what we send, and what the panel sends that expects a
// CommandResponse. Notifications and status answers don't have one.
const WITH_APP_SEQ = new Set([
  0x060a, 0x060e, // open session, request access (both directions)
  0x0701, 0x0704, 0x074a, // configuration
  0x0800, // request
  0x0900, 0x0901, 0x0902, 0x0908, // arm, disarm, output, keypad alarm
  0x0f00,
]);

function lengthBytes(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n > 0x7fff) throw new Error(`Packet too long (${n} bytes)`);
  return Buffer.from([0x80 | (n >> 8), n & 0xff]);
}

/** @param p { seq, ack, cmd?, appSeq?, payload? } — no cmd: a bare acknowledgement */
function encode({ seq, ack, cmd = null, appSeq = null, payload = Buffer.alloc(0) }) {
  const parts = [Buffer.from([seq & 0xff, ack & 0xff])];
  if (cmd != null) {
    parts.push(Buffer.from([(cmd >> 8) & 0xff, cmd & 0xff]));
    if (appSeq != null) parts.push(Buffer.from([appSeq & 0xff]));
    parts.push(payload);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.concat([lengthBytes(body.length + 2), body]);
  const crc = crc16(head);
  return Buffer.concat([head, Buffer.from([crc >> 8, crc & 0xff])]);
}

/**
 * The packets in a decrypted frame body (usually one; padding after the last is ignored).
 * Each: { seq, ack, cmd, appSeq, payload, crcOk, raw }.
 */
function decodeAll(buf) {
  const packets = [];
  let pos = 0;
  while (pos < buf.length) {
    let len = buf[pos];
    let headLen = 1;
    if (len & 0x80) {
      if (pos + 1 >= buf.length) break;
      len = ((len & 0x7f) << 8) | buf[pos + 1];
      headLen = 2;
    }
    if (len < 4 || pos + headLen + len > buf.length) break; // the rest is padding (or garbage)
    const raw = buf.subarray(pos, pos + headLen + len);
    const crc = raw.readUInt16BE(raw.length - 2);
    const body = raw.subarray(headLen, raw.length - 2);
    const packet = { seq: body[0], ack: body[1], cmd: null, appSeq: null, payload: Buffer.alloc(0), crcOk: crc16(raw.subarray(0, raw.length - 2)) === crc, raw };
    if (body.length >= 4) {
      packet.cmd = body.readUInt16BE(2);
      let rest = body.subarray(4);
      if (WITH_APP_SEQ.has(packet.cmd) && rest.length) {
        packet.appSeq = rest[0];
        rest = rest.subarray(1);
      }
      packet.payload = rest;
    }
    packets.push(packet);
    pos += raw.length;
  }
  return packets;
}

module.exports = { encode, decodeAll, WITH_APP_SEQ };
