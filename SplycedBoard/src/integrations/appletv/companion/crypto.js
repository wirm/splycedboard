/**
 * Crypto primitives for Companion pairing and sessions.
 *
 * Ed25519, X25519 and ChaCha20-Poly1305 come from the audited pure-JS @noble libraries,
 * so they behave identically under Bun (which the Pro Hosts run) and Node.
 */
const nodeCrypto = require('crypto');
const { ed25519, x25519 } = require('@noble/curves/ed25519');
const { chacha20poly1305 } = require('@noble/ciphers/chacha');

const randomBytes = (n) => nodeCrypto.randomBytes(n);

/** HKDF-SHA512 (RFC 5869). salt/info may be strings. */
function hkdf(ikm, salt, info, length = 32) {
  const hmac = (key, data) => nodeCrypto.createHmac('sha512', key).update(data).digest();
  const prk = hmac(Buffer.from(salt), ikm);
  const blocks = [];
  let prev = Buffer.alloc(0);
  for (let i = 1, total = 0; total < length; i++, total += prev.length) {
    prev = hmac(prk, Buffer.concat([prev, Buffer.from(info), Buffer.from([i])]));
    blocks.push(prev);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

// ── ChaCha20-Poly1305 ────────────────────────────────────────────────────────

/** Pairing messages use a fixed label as nonce: 4 zero bytes + e.g. "PV-Msg02". */
const labelNonce = (label) => Buffer.concat([Buffer.alloc(4), Buffer.from(label)]);

/** Session frames use a per-direction message counter, 12 bytes little-endian. */
function counterNonce(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(BigInt(counter), 0);
  return nonce;
}

/** → ciphertext with the 16-byte tag appended */
function seal(key, nonce, plaintext, aad) {
  return Buffer.from(chacha20poly1305(key, nonce, aad).encrypt(plaintext));
}

/** Throws if the data was tampered with or the key is wrong. */
function open(key, nonce, ciphertext, aad) {
  return Buffer.from(chacha20poly1305(key, nonce, aad).decrypt(ciphertext));
}

// ── Keys ─────────────────────────────────────────────────────────────────────

function ed25519KeyPair() {
  const secret = randomBytes(32);
  return { secret, public: Buffer.from(ed25519.getPublicKey(secret)) };
}

const ed25519Sign = (secret, message) => Buffer.from(ed25519.sign(message, secret));

function ed25519Verify(publicKey, message, signature) {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

function x25519KeyPair() {
  const secret = randomBytes(32);
  return { secret, public: Buffer.from(x25519.getPublicKey(secret)) };
}

const x25519Shared = (secret, peerPublic) => Buffer.from(x25519.getSharedSecret(secret, peerPublic));

module.exports = {
  randomBytes,
  hkdf,
  labelNonce,
  counterNonce,
  seal,
  open,
  ed25519KeyPair,
  ed25519Sign,
  ed25519Verify,
  x25519KeyPair,
  x25519Shared,
};
