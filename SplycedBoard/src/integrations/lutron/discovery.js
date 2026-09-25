/**
 * Finds Lutron LEAP processors on the local network.
 *
 *   1. mDNS/Bonjour: processors advertise _lutron._tcp (as "Lutron Status", on port 22) and
 *      some also _leap._tcp.
 *   2. When that finds nothing, a direct look at the local /24: a processor is an address
 *      with both LEAP ports open, 8083 (pairing) and 8081 (LEAP). This works where multicast
 *      doesn't.
 *
 * Network errors are kept rather than swallowed. When macOS won't let SplycedBoard onto the
 * local network (Local Network privacy, macOS 15 and later), even hosts that certainly exist,
 * the router and the device the dashboard is open on, fail at once. The result then says so,
 * instead of just finding nothing.
 */
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPES = ['lutron', 'leap'];
const LEAP_PORT = 8081;
const PAIRING_PORT = 8083;
const EARLY_RETURN_GRACE_MS = 1000; // after the first find, wait this long for more
const CONNECT_TIMEOUT_MS = 700;
const SWEEP_CONCURRENCY = 64;
const BLOCKED_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EPERM', 'EACCES']);

const BLOCKED_MESSAGE = "macOS isn't letting SplycedBoard reach devices on the local network. "
  + 'On the Pro Host, open System Settings → Privacy & Security → Local Network and switch on '
  + '"bun" (or "node"), then scan again.';

/** mDNS browse. Resolves to { processors, problems } (problems: error codes seen). */
function browse(timeoutMs, log) {
  return new Promise((resolve) => {
    const found = new Map();
    const problems = [];
    const noteProblem = (err) => problems.push(err?.code || err?.message || String(err));
    let bonjour;
    try {
      bonjour = new Bonjour({}, noteProblem);
      bonjour.server?.mdns?.on('warning', noteProblem); // send failures arrive as warnings
      bonjour.server?.mdns?.on('error', noteProblem);
    } catch (err) {
      noteProblem(err);
      resolve({ processors: [], problems });
      return;
    }

    let earlyTimer = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(earlyTimer);
      clearTimeout(hardTimer);
      browsers.forEach((b) => b?.stop());
      try { bonjour.destroy(); } catch { /* already closed */ }
      resolve({ processors: [...found.values()], problems });
    };
    const hardTimer = setTimeout(finish, timeoutMs);

    const onUp = (service) => {
      const host = service.addresses?.find((a) => net.isIPv4(a)) || service.addresses?.[0] || service.host?.replace(/\.$/, '');
      if (!host || found.has(host)) return;
      const processor = {
        id: host,
        name: service.name || service.host,
        host,
        port: LEAP_PORT, // what SplycedBoard connects to; the advertisement's own port is its status service
        type: service.type,
        fqdn: service.fqdn || service.host,
        addresses: service.addresses || [host],
      };
      found.set(host, processor);
      log.info(`Found: ${processor.name} at ${host}`);
      clearTimeout(earlyTimer);
      earlyTimer = setTimeout(finish, EARLY_RETURN_GRACE_MS);
    };

    const browsers = SERVICE_TYPES.map((type) => {
      try {
        return bonjour.find({ type }).on('up', onUp);
      } catch (err) {
        noteProblem(err);
        return null;
      }
    });
  });
}

/** One TCP connection attempt: { ok, code, ms }. */
function tryConnect(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
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

/** Every other address in the /24 around each of this machine's IPv4 addresses. */
function localTargets() {
  const targets = new Set();
  const own = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      own.add(a.address);
      const prefix = a.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i < 255; i++) targets.add(`${prefix}.${i}`);
    }
  }
  for (const a of own) targets.delete(a);
  return [...targets];
}

/** Addresses that have both LEAP ports open. */
async function sweep(targets, { ports = [PAIRING_PORT, LEAP_PORT], timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const processors = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const host = targets[next++];
      let open = true;
      for (const port of ports) {
        if (!(await tryConnect(host, port, timeoutMs)).ok) {
          open = false;
          break;
        }
      }
      if (open) processors.push({ id: host, name: `Lutron processor at ${host}`, host, port: LEAP_PORT, type: 'direct', addresses: [host] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, targets.length) }, worker));
  return processors.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
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
 * Can this process reach the local network at all? Asks hosts that certainly exist. A
 * refused or accepted connection means yes; failing at once with "no route" (Local Network
 * privacy) means no; timeouts don't tell either way.
 */
async function localNetworkBlocked(knownHosts, { connect = tryConnect } = {}) {
  const hosts = [...new Set(knownHosts.filter((h) => h && net.isIPv4(h) && !h.startsWith('127.')))];
  if (!hosts.length) return false;
  const results = await Promise.all(hosts.map((h) => connect(h, 80, 1500)));
  if (results.some((r) => r.ok || r.code === 'ECONNREFUSED')) return false;
  return results.every((r) => BLOCKED_CODES.has(r.code));
}

/**
 * @param timeoutMs  how long the mDNS browse may take
 * @param client     address of the dashboard that asked (a host known to be on the network)
 * @returns { processors, problem } — problem: a message for the user, or null
 */
async function discoverProcessors(timeoutMs = 5000, { log, client = null } = {}) {
  const browsed = await browse(timeoutMs, log);
  if (browsed.problems.length) log.warn(`mDNS problems while scanning: ${[...new Set(browsed.problems)].join(', ')}`);
  if (browsed.processors.length) return { processors: browsed.processors, problem: null };

  log.info('mDNS found nothing; checking the local network for LEAP ports directly');
  const processors = await sweep(localTargets());
  for (const p of processors) log.info(`Found: LEAP ports open at ${p.host}`);
  if (processors.length) return { processors, problem: null };

  if (await localNetworkBlocked([client, await defaultGateway()])) {
    log.warn(BLOCKED_MESSAGE);
    return { processors: [], problem: BLOCKED_MESSAGE };
  }
  return { processors: [], problem: null };
}

module.exports = { discoverProcessors, sweep, tryConnect, localNetworkBlocked, BLOCKED_MESSAGE };
