/**
 * Samsung IP Control: the JSON-RPC API that 2020-and-newer Samsung TVs serve on port 1516 once
 * "IP Remote" is on (Settings → All Settings → Connection → Network → Expert Settings).
 * Savant's own Samsung profiles (samsung_tv (2025).xml and the other 2020+ models) control TVs
 * this way, with an AccessToken the TV hands out after someone picks Allow on its screen.
 *
 *   createAccessToken(address)   asks for a token; the TV shows Allow/Deny (answer within 30 s)
 *   call(address, method, params, { token })
 *
 * Queries are the same methods with only the token: powerControl → { power: 'powerOn' },
 * directVolumeControl → { volume: 12 }, muteControl → { mute: 'muteOff' }.
 */
const lan = require('../../core/lan');

const PORTS = { ipControl: 1516 };

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function call(address, method, params = {}, { token = null, timeoutMs = 4000 } = {}) {
  const body = { id: 1, method, jsonrpc: '2.0', params: token ? { AccessToken: token, ...params } : params };
  let res;
  try {
    res = await lan.request(`https://${address}:${PORTS.ipControl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      timeoutMs,
    });
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw httpError(502, `The TV at ${address} isn't taking IP Control (port ${PORTS.ipControl}). Turn on IP Remote: Settings → All Settings → Connection → Network → Expert Settings → IP Remote.`);
    }
    throw httpError(502, lan.unreachable(err) ? `The TV at ${address} didn't answer. Is it on and on the network?` : `Couldn't reach the TV at ${address}: ${err.message}`);
  }
  const error = res.json?.error;
  if (error) {
    const text = typeof error === 'string' ? error : error.message || JSON.stringify(error);
    throw Object.assign(httpError(502, `The TV said: ${text}`), { rpcError: error });
  }
  if (res.status >= 400) throw httpError(502, `The TV answered HTTP ${res.status}`);
  return res.json?.result ?? {};
}

/** @returns the AccessToken, once someone picks Allow on the TV */
async function createAccessToken(address, { timeoutMs = 60000 } = {}) {
  let result;
  try {
    result = await call(address, 'createAccessToken', {}, { timeoutMs });
  } catch (err) {
    if (err.rpcError) throw httpError(502, `The TV didn't give a token (${err.message.replace(/^The TV said: /, '')}). Was Deny picked, or did the 30 seconds run out?`);
    throw err;
  }
  const token = result?.AccessToken;
  if (!token) throw httpError(502, 'The TV answered without a token. Was Deny picked, or did the 30 seconds run out?');
  return String(token);
}

module.exports = { PORTS, call, createAccessToken };
