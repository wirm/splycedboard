/**
 * Finds Lutron LEAP processors on the local network.
 *
 *   1. mDNS/Bonjour: processors advertise _lutron._tcp (as "Lutron Status", on port 22) and
 *      some also _leap._tcp.
 *   2. When that finds nothing, a direct look at the local /24: a processor is an address
 *      with both LEAP ports open, 8083 (pairing) and 8081 (LEAP). This works where multicast
 *      doesn't.
 *   3. When that finds nothing either, advice: most often, macOS isn't letting SplycedBoard
 *      onto the local network (core/local-network.js).
 *
 * Network errors are logged rather than swallowed.
 */
const net = require('net');
const os = require('os');
const { Bonjour } = require('bonjour-service');
const { tryConnect, adviceForEmptyScan } = require('../../core/local-network');

const SERVICE_TYPES = ['lutron', 'leap'];
const LEAP_PORT = 8081;
const PAIRING_PORT = 8083;
const EARLY_RETURN_GRACE_MS = 1000; // after the first find, wait this long for more
const SWEEP_CONCURRENCY = 64;

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
async function sweep(targets, { ports = [PAIRING_PORT, LEAP_PORT] } = {}) {
  const processors = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const host = targets[next++];
      let open = true;
      for (const port of ports) {
        if (!(await tryConnect(host, port)).ok) {
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

/**
 * @param timeoutMs  how long the mDNS browse may take
 * @param client     address of the dashboard that asked (a host known to be on the network)
 * @param steps      replaces browse / sweep / advise (tests)
 * @returns { processors, problem, hint }: problem when macOS is provably blocking the local
 *          network, hint when nothing was found otherwise
 */
async function discoverProcessors(timeoutMs = 5000, { log, client = null, steps = {} } = {}) {
  const run = {
    browse: () => browse(timeoutMs, log),
    sweep: () => sweep(localTargets()),
    advise: () => adviceForEmptyScan({ what: 'Lutron processors', fallback: 'Or add the processor by IP with Manual Entry.', client }),
    ...steps,
  };

  const browsed = await run.browse();
  if (browsed.problems.length) log.warn(`mDNS problems while scanning: ${[...new Set(browsed.problems)].join(', ')}`);
  if (browsed.processors.length) return { processors: browsed.processors, problem: null, hint: null };

  log.info('mDNS found nothing; checking the local network for LEAP ports directly');
  const processors = await run.sweep();
  for (const p of processors) log.info(`Found: LEAP ports open at ${p.host}`);
  if (processors.length) return { processors, problem: null, hint: null };

  const advice = await run.advise();
  log.warn(advice.problem || advice.hint);
  return { processors: [], ...advice };
}

module.exports = { discoverProcessors, sweep };
