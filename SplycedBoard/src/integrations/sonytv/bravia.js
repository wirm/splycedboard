/**
 * Sony BRAVIA IP control: the REST API on port 80 (JSON-RPC under /sony/<service>) and IRCC
 * remote codes (SOAP under /sony/ircc). With the TV's IP Control → Authentication set to
 * "Normal and Pre-Shared Key", every request carries the key in an X-Auth-PSK header.
 * Savant's Sony profiles send 1234.
 *
 *   call(address, service, method, params, { psk })   → the result (its first element)
 *   ircc(address, code, { psk })                        presses a remote button
 */
const lan = require('../../core/lan');

const PORTS = { http: 80 };

const httpError = (status, message) => Object.assign(new Error(message), { status });

const base = (address) => `http://${address}${PORTS.http === 80 ? '' : `:${PORTS.http}`}`;

function authError(address) {
  return Object.assign(httpError(403, `The TV at ${address} turned down the Pre-Shared Key.`), { auth: true });
}

/** raw: the whole result array (getRemoteControllerInfo answers [info, [codes]]) */
async function call(address, service, method, params = [], { psk = null, version = '1.0', timeoutMs = 3000, raw = false } = {}) {
  let res;
  try {
    res = await lan.request(`${base(address)}/sony/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', ...(psk ? { 'X-Auth-PSK': psk } : {}) },
      body: { method, id: 1, params, version },
      timeoutMs,
    });
  } catch (err) {
    throw httpError(502, lan.unreachable(err) ? `The TV at ${address} didn't answer. Is it on and on the network?` : `Couldn't reach the TV at ${address}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw authError(address);
  const error = res.json?.error;
  if (Array.isArray(error)) {
    if (error[0] === 401 || error[0] === 403) throw authError(address);
    throw Object.assign(httpError(502, `The TV said: ${error[1] || error[0]}`), { code: error[0] });
  }
  if (res.status >= 400 || !res.json) throw httpError(502, `The TV answered HTTP ${res.status}`);
  const result = res.json.result;
  return Array.isArray(result) && !raw ? result[0] : result;
}

async function ircc(address, code, { psk = null, timeoutMs = 3000 } = {}) {
  const body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">'
    + `<IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`;
  let res;
  try {
    res = await lan.request(`${base(address)}/sony/ircc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
        ...(psk ? { 'X-Auth-PSK': psk } : {}),
      },
      body,
      timeoutMs,
    });
  } catch (err) {
    throw httpError(502, lan.unreachable(err) ? `The TV at ${address} didn't answer. Is it on and on the network?` : `Couldn't reach the TV at ${address}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw authError(address);
  if (res.status >= 400) throw httpError(502, `The TV answered HTTP ${res.status} to the button`);
}

module.exports = { PORTS, call, ircc };
