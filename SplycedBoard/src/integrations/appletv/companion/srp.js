/**
 * SRP-6a client for pairing, as Apple uses it (HAP variant): the RFC 5054 3072-bit group,
 * g = 5, SHA-512, username "Pair-Setup", password = the PIN shown on the TV.
 *
 * Implementations disagree on how to encode numbers whose top byte is zero (padded to
 * the group size, or minimal). This client always uses fixed-length encodings, and picks
 * its private value so that A, S and K never start with a zero byte — then every value
 * *we* choose encodes the same either way, and pairing doesn't depend on which
 * convention the Apple TV uses.
 */
const crypto = require('crypto');

const N = BigInt('0x'
  + 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74'
  + '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437'
  + '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED'
  + 'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05'
  + '98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB'
  + '9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B'
  + 'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718'
  + '3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33'
  + 'A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7'
  + 'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864'
  + 'D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2'
  + '08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF');
const g = 5n;
const N_BYTES = 384;
const USERNAME = 'Pair-Setup';

function sha512(...parts) {
  const h = crypto.createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Big-endian bytes; padded to `length` when given. */
function toBytes(n, length) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const b = Buffer.from(hex, 'hex');
  if (!length) return b;
  if (b.length > length) throw new RangeError('SRP value too large');
  return Buffer.concat([Buffer.alloc(length - b.length), b]);
}

const toBigInt = (buf) => (buf.length ? BigInt('0x' + buf.toString('hex')) : 0n);

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

const k = toBigInt(sha512(toBytes(N, N_BYTES), toBytes(g, N_BYTES)));
const H_N_XOR_H_g = xor(sha512(toBytes(N)), sha512(toBytes(g)));

/**
 * Run the client side of SRP given the Apple TV's salt and public key (pairing M2).
 * @returns {{ A: Buffer, M1: Buffer, K: Buffer, expectedM2: Buffer }}
 */
function srpClient({ pin, salt, serverPublic, randomBytes = crypto.randomBytes }) {
  const B = toBigInt(serverPublic);
  if (B % N === 0n) throw new Error('Invalid SRP public key from the Apple TV');
  const B_bytes = toBytes(B, N_BYTES);

  const x = toBigInt(sha512(salt, sha512(Buffer.from(`${USERNAME}:${pin}`))));
  const gx = modPow(g, x, N);

  for (let attempt = 0; attempt < 100; attempt++) {
    const a = toBigInt(randomBytes(32));
    if (a === 0n) continue;
    const A_bytes = toBytes(modPow(g, a, N), N_BYTES);
    if (A_bytes[0] === 0) continue;

    const u = toBigInt(sha512(A_bytes, B_bytes));
    if (u === 0n) continue;

    const base = (((B - k * gx) % N) + N) % N;
    const S_bytes = toBytes(modPow(base, a + u * x, N), N_BYTES);
    if (S_bytes[0] === 0) continue;

    const K = sha512(S_bytes);
    if (K[0] === 0) continue;

    const M1 = sha512(H_N_XOR_H_g, sha512(Buffer.from(USERNAME)), salt, A_bytes, B_bytes, K);
    return { A: A_bytes, M1, K, expectedM2: sha512(A_bytes, M1, K) };
  }
  throw new Error('SRP: could not pick a private key');
}

module.exports = { srpClient, N, g };
