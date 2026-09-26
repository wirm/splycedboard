/**
 * Samsung IP Control: the JSON-RPC API Samsung TVs serve over HTTPS once "IP Remote" is on.
 *   2020 and newer   port 1516 (Settings → All Settings → Connection → Network → Expert Settings)
 *   2016–2019        port 1515 on the models that have it: MU, NU and RU series, Q7F–Q9F,
 *                    Q50R–Q950R, The Frame LS003/LS03N/LS03R… (Settings → General → Network →
 *                    Expert Settings)
 * Savant's own Samsung profiles control TVs this way (the same methods on both ports), with an
 * AccessToken the TV hands out after someone picks Allow on its screen.
 *
 *   createAccessToken(address, { port })   asks for a token; the TV shows Allow/Deny (30 s)
 *   call(address, method, params, { token, port })
 *
 * Queries are the same methods with only the token: powerControl → { power: 'powerOn' },
 * directVolumeControl → { volume: 12 }, muteControl → { mute: 'muteOff' }.
 */
const lan = require('../../core/lan');

const PORTS = { ipControl: 1516, ipControl2016: 1515 };

/** Where to find it, newest first. */
const ipControlPorts = () => [PORTS.ipControl, PORTS.ipControl2016];

/** The menu with the IP Remote switch, by the TV's year. */
function ipRemoteSetting(year) {
  return (year || 0) >= 2020
    ? 'Settings → All Settings → Connection → Network → Expert Settings'
    : 'Settings → General → Network → Expert Settings';
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function call(address, method, params = {}, { token = null, port = PORTS.ipControl, timeoutMs = 4000 } = {}) {
  const body = { id: 1, method, jsonrpc: '2.0', params: token ? { AccessToken: token, ...params } : params };
  let res;
  try {
    res = await lan.request(`https://${address}:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      timeoutMs,
    });
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw httpError(502, `The TV at ${address} isn't taking IP Control (port ${port}). Is IP Remote on in its network settings (Expert Settings)?`);
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
async function createAccessToken(address, { port = PORTS.ipControl, timeoutMs = 60000 } = {}) {
  let result;
  try {
    result = await call(address, 'createAccessToken', {}, { port, timeoutMs });
  } catch (err) {
    if (err.rpcError) throw httpError(502, `The TV didn't give a token (${err.message.replace(/^The TV said: /, '')}). Was Deny picked, or did the 30 seconds run out?`);
    throw err;
  }
  const token = result?.AccessToken;
  if (!token) throw httpError(502, 'The TV answered without a token. Was Deny picked, or did the 30 seconds run out?');
  return String(token);
}

module.exports = { PORTS, ipControlPorts, ipRemoteSetting, call, createAccessToken };
