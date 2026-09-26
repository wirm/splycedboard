/**
 * Finding, reaching and waking devices on the Pro Host's local network. The TV tools use it.
 *
 *   localSubnets()          the host's IPv4 networks, each as the /24 around the host's address
 *   liveHosts()             which addresses in those /24s are in use, with their MACs
 *   sweep(ports)            every address in those /24s with one of `ports` open
 *   ssdp(targets)           SSDP M-SEARCH: who answers for these search targets, and where their
 *                           UPnP description is; `address` asks one device directly
 *   describe(location)      a UPnP device description: friendlyName, manufacturer, modelName…
 *   macAddress(ip)          from the ARP table, once something has talked to the IP
 *   wake(mac)               Wake-on-LAN magic packet, to every broadcast address
 *   request(url)            HTTP(S): self-signed certificates accepted, a body, a timeout
 */
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');
const { execFile } = require('child_process');

const { tryConnect } = require('./local-network');

/** How long a one-device UPnP question waits for an answer (tests shorten it). */
const timing = { probeSsdpMs: 1500 };

const UNREACHABLE = new Set(['TIMEOUT', 'ETIMEDOUT', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE']);

/** Did a connection fail because nothing answers there (off, unplugged, wrong address)? */
const unreachable = (err) => UNREACHABLE.has(err?.code);

const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '')) && String(s).split('.').every((n) => Number(n) <= 255);

/** "0:11:2:AA:bb:c" (how macOS's arp prints them) → "00:11:02:AA:BB:0C"; null if it isn't one. */
function normalizeMac(mac) {
  const parts = String(mac || '').trim().split(/[:-]/);
  if (parts.length !== 6 || !parts.every((p) => /^[0-9a-f]{1,2}$/i.test(p))) {
    const bare = String(mac || '').trim().replace(/[^0-9a-f]/gi, '');
    if (bare.length !== 12) return null;
    return bare.match(/../g).join(':').toUpperCase();
  }
  const out = parts.map((p) => p.padStart(2, '0').toUpperCase()).join(':');
  return out === '00:00:00:00:00:00' || out === 'FF:FF:FF:FF:FF:FF' ? null : out;
}

function ipToInt(ip) {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** [{ address, netmask, broadcast, base }]: the host's IPv4 interfaces (no loopback, no 169.254). */
function localInterfaces(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const ip = ipToInt(a.address);
      const mask = ipToInt(a.netmask || '255.255.255.0');
      out.push({ address: a.address, netmask: a.netmask, broadcast: intToIp((ip & mask) | (~mask >>> 0)), base: intToIp(ip & mask) });
    }
  }
  return out;
}

/** The /24 around each of the host's addresses: ['192.168.5'], without duplicates. */
function localSubnets(interfaces) {
  return [...new Set(localInterfaces(interfaces).map((i) => i.address.split('.').slice(0, 3).join('.')))];
}

/** Run fn over items, at most `limit` at a time. */
async function eachLimited(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

/** The ARP table (macOS `arp -an`): Map address → MAC, answered entries only. */
function arpTable({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    execFile('arp', ['-an'], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const table = new Map();
      if (!err) {
        for (const m of String(stdout).matchAll(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/gi)) {
          const mac = normalizeMac(m[2]);
          if (mac) table.set(m[1], mac);
        }
      }
      resolve(table);
    });
  });
}

/**
 * Which addresses in the host's /24s are in use: one UDP datagram to each (the discard port)
 * makes macOS ask the network who has it, and whoever answers lands in the ARP table.
 * Much quicker than waiting on hundreds of TCP connections that nobody answers.
 * @returns Map address → MAC
 */
async function liveHosts({ subnets = localSubnets(), waitMs = 1500 } = {}) {
  const own = new Set(localInterfaces().map((i) => i.address));
  const addresses = [];
  for (const subnet of subnets) {
    for (let i = 1; i < 255; i++) {
      if (!own.has(`${subnet}.${i}`)) addresses.push(`${subnet}.${i}`);
    }
  }
  await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = () => {
      try { socket.close(); } catch { /* already closed */ }
      resolve();
    };
    socket.on('error', () => { /* "host is down" for addresses nobody has */ });
    socket.bind(0, () => {
      const probe = Buffer.alloc(1);
      for (const address of addresses) socket.send(probe, 9, address, () => {});
      setTimeout(finish, waitMs);
    });
  });
  const table = await arpTable();
  const inSubnets = new Map();
  for (const [address, mac] of table) {
    if (subnets.includes(address.split('.').slice(0, 3).join('.')) && !own.has(address)) inSubnets.set(address, mac);
  }
  return inSubnets;
}

/**
 * Every address in the host's /24s with at least one of `ports` open. Asks only addresses
 * something answers on (liveHosts); if that finds nobody, tries every address.
 * @returns Map address → { ports: [open ports], mac }
 */
async function sweep(ports, { subnets = localSubnets(), timeoutMs = 900, concurrency = 128, connect = tryConnect, hosts = null } = {}) {
  let live = hosts || await liveHosts({ subnets });
  if (!live.size) {
    const own = new Set(localInterfaces().map((i) => i.address));
    live = new Map();
    for (const subnet of subnets) {
      for (let i = 1; i < 255; i++) {
        if (!own.has(`${subnet}.${i}`)) live.set(`${subnet}.${i}`, null);
      }
    }
  }
  const targets = [];
  for (const address of live.keys()) for (const port of ports) targets.push([address, port]);
  const open = new Map();
  await eachLimited(targets, concurrency, async ([address, port]) => {
    const r = await connect(address, port, timeoutMs);
    if (!r.ok) return;
    if (!open.has(address)) open.set(address, { ports: [], mac: live.get(address) || null });
    open.get(address).ports.push(port);
  });
  for (const entry of open.values()) entry.ports.sort((a, b) => a - b);
  return open;
}

function parseHeaders(text) {
  const headers = {};
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/**
 * SSDP M-SEARCH for `targets` (search targets, "ST"), multicast to the whole network or,
 * with `address`, to that one device.
 * @returns Map address → { location, server, targets: [st], usn }
 */
function ssdp(targets, { timeoutMs = 2500, address = null, mx = 2 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve(found);
      return;
    }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(found);
    };
    const timer = setTimeout(done, timeoutMs);
    socket.on('error', done);
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/^HTTP\/1\.[01] 200/i.test(text) && !/^NOTIFY/i.test(text)) return;
      if (address && rinfo.address !== address) return;
      const h = parseHeaders(text);
      const entry = found.get(rinfo.address) || { location: null, server: null, targets: [], usn: null };
      entry.location = entry.location || h.location || null;
      entry.server = entry.server || h.server || null;
      entry.usn = entry.usn || h.usn || null;
      if (h.st && !entry.targets.includes(h.st)) entry.targets.push(h.st);
      found.set(rinfo.address, entry);
    });
    socket.bind(0, () => {
      const dest = address || '239.255.255.250';
      const send = () => {
        for (const st of targets) {
          const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${st}\r\n\r\n`);
          socket.send(msg, 1900, dest, () => {});
        }
      };
      send();
      // UDP gets lost; ask twice.
      setTimeout(() => { if (!finished) send(); }, 400);
    });
  });
}

/**
 * An HTTP(S) request.
 * @returns { status, headers, text, json } — json is null when the body isn't JSON
 */
function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request({
      method,
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
      // TVs answer with self-signed certificates.
      rejectUnauthorized: false,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', fail);
    });
    const timer = setTimeout(() => {
      req.destroy();
      fail(Object.assign(new Error(`No answer from ${u.host} within ${Math.round(timeoutMs / 1000)} s`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    function fail(err) {
      clearTimeout(timer);
      reject(err);
    }
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

const xmlDecode = (s) => String(s).replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));

/** The first device in a UPnP description: { friendlyName, manufacturer, modelName, modelNumber, … }. */
async function describe(location, { timeoutMs = 2500 } = {}) {
  try {
    const { status, text } = await request(location, { timeoutMs });
    if (status !== 200) return null;
    const device = text.match(/<device\b[^>]*>([\s\S]*)<\/device>/i)?.[1] || text;
    const tag = (name) => {
      const m = device.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`, 'i'));
      return m ? xmlDecode(m[1]).trim() : null;
    };
    return {
      friendlyName: tag('friendlyName'),
      manufacturer: tag('manufacturer'),
      modelName: tag('modelName'),
      modelNumber: tag('modelNumber'),
      modelDescription: tag('modelDescription'),
      serialNumber: tag('serialNumber'),
      udn: tag('UDN'),
    };
  } catch {
    return null;
  }
}

/** A device's MAC address from the ARP table (macOS `arp -n`), or null. */
function macAddress(ip, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!isIPv4(ip)) {
      resolve(null);
      return;
    }
    execFile('arp', ['-n', ip], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const m = String(stdout).match(/\bat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i);
      resolve(m ? normalizeMac(m[1]) : null);
    });
  });
}

/** The Wake-on-LAN magic packet for a MAC address. */
function magicPacket(mac) {
  const hex = normalizeMac(mac)?.replace(/:/g, '');
  if (!hex) throw Object.assign(new Error(`"${mac}" isn't a MAC address`), { status: 400 });
  const target = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(target)]);
}

/**
 * Sends the magic packet to 255.255.255.255, every interface's broadcast address and, when
 * given, the device's own /24, on ports 9 and 7.
 * @returns how many packets went out
 */
function wake(mac, { address = null } = {}) {
  const packet = magicPacket(mac);
  const targets = new Set(['255.255.255.255', ...localInterfaces().map((i) => i.broadcast)]);
  if (isIPv4(address)) targets.add(`${address.split('.').slice(0, 3).join('.')}.255`);
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let sent = 0;
    const finish = () => {
      try { socket.close(); } catch { /* already closed */ }
      resolve(sent);
    };
    socket.on('error', finish);
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        finish();
        return;
      }
      const sends = [];
      for (const host of targets) {
        for (const port of [9, 7]) {
          sends.push(new Promise((r) => socket.send(packet, port, host, (err) => {
            if (!err) sent += 1;
            r();
          })));
        }
      }
      Promise.all(sends).then(finish);
    });
  });
}

module.exports = {
  timing,
  unreachable,
  isIPv4,
  normalizeMac,
  localInterfaces,
  localSubnets,
  eachLimited,
  arpTable,
  liveHosts,
  sweep,
  ssdp,
  request,
  describe,
  macAddress,
  magicPacket,
  wake,
};
