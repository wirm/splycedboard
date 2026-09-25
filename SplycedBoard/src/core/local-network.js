/**
 * Reaching devices on the local network from the Pro Host.
 *
 * On macOS 15 and later a program needs permission to talk to local devices (System Settings
 * → Privacy & Security → Local Network). SplycedBoard runs as "bun" (or "node"), and macOS
 * asks once, on the host's own screen. Until someone allows it, scans find nothing and
 * connections fail with "No route to host", which looks just like an empty network.
 *
 * These helpers tell the two apart where they can, and word the advice for when a scan comes
 * back empty.
 */
const net = require('net');
const { execFile } = require('child_process');

const RUNTIME = process.versions.bun ? 'bun' : 'node';
const BLOCKED_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EPERM', 'EACCES']);
const SETTING = `On the Pro Host, open System Settings → Privacy & Security → Local Network and switch on "${RUNTIME}".`;

/** One TCP connection attempt: { ok, code, ms }. */
function tryConnect(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, code) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, code, ms: Date.now() - started });
    };
    const timer = setTimeout(() => done(false, 'TIMEOUT'), timeoutMs);
    socket.once('connect', () => done(true, null));
    socket.once('error', (err) => done(false, err.code || 'ERROR'));
  });
}

/** The default gateway's IPv4 address (macOS `route`), or null. */
function defaultGateway() {
  return new Promise((resolve) => {
    execFile('route', ['-n', 'get', 'default'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : (String(stdout).match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null));
    });
  });
}

/**
 * Is this process kept off the local network? Asks hosts that certainly exist (the router,
 * the device the dashboard is open on). A refused or accepted connection means no; all of
 * them failing with "no route" means yes; timeouts don't tell either way.
 */
async function localNetworkBlocked(knownHosts, { connect = tryConnect } = {}) {
  const hosts = [...new Set(knownHosts.filter((h) => h && net.isIPv4(h) && !h.startsWith('127.')))];
  if (!hosts.length) return false;
  const results = await Promise.all(hosts.map((h) => connect(h, 80, 1500)));
  if (results.some((r) => r.ok || r.code === 'ECONNREFUSED')) return false;
  return results.every((r) => BLOCKED_CODES.has(r.code));
}

const blockedMessage = () => `macOS isn't letting SplycedBoard reach devices on the local network. ${SETTING} Then scan again.`;

/**
 * What to tell the user when a scan finds nothing.
 *
 * @param what      "Lutron processors", "Apple TVs"
 * @param fallback  the other way in, e.g. "Or add the processor by IP with Manual Entry."
 * @param client    the dashboard's address: a host known to be on the network
 * @returns { problem } when macOS is provably blocking the local network, else { hint }
 *          pointing at the same setting, the likeliest reason on a Pro Host.
 */
async function adviceForEmptyScan({ what, fallback, client = null, isBlocked = localNetworkBlocked, gateway = defaultGateway }) {
  if (await isBlocked([client, await gateway()])) return { problem: blockedMessage(), hint: null };
  return {
    problem: null,
    hint: `No ${what} found. If there's one on this network, macOS may be keeping SplycedBoard from reaching it. `
      + `${SETTING} Then scan again. ${fallback}`,
  };
}

module.exports = { RUNTIME, tryConnect, defaultGateway, localNetworkBlocked, blockedMessage, adviceForEmptyScan };
