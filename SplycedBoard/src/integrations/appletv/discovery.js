/**
 * Finding Apple TVs.
 *
 * Apple TVs advertise the Companion service as _companion-link._tcp (as do HomePods,
 * iPhones and Macs — the model TXT record "rpMd" tells them apart, e.g. "AppleTV14,1").
 *
 *   scan()          multicast browse of the local network
 *   probe(address)  ask one IP directly (a DNS-SD query sent to its port 5353), which
 *                   works even where multicast is filtered between VLANs
 */
const dgram = require('dgram');
const dnsPacket = require('dns-packet');
const { Bonjour } = require('bonjour-service');

const SERVICE = '_companion-link._tcp.local';
const DEFAULT_PORT = 49153;

// Macs advertise the same service without a model, so the scan requires one;
// pairing by IP works regardless.
const isAppleTv = (model) => /^AppleTV/i.test(model || '');

function parseTxt(data) {
  const out = {};
  for (const entry of [].concat(data || [])) {
    const text = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry);
    const eq = text.indexOf('=');
    if (eq > 0) out[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return out;
}

/** @returns {Promise<Array<{ name, address, port, model }>>} Apple TVs only, sorted by name */
function scan({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = new Map();
    const browser = bonjour.find({ type: 'companion-link' }, (service) => {
      const model = service.txt?.rpMd || null;
      const address = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      if (!address || !isAppleTv(model)) return;
      found.set(address, { name: service.name, address, port: service.port || DEFAULT_PORT, model });
    });
    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }, timeoutMs);
  });
}

/** @returns {Promise<{ name, address, port, model } | null>} null if nothing answered */
function probe(address, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let timer = null;
    const done = (result) => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    timer = setTimeout(() => done(null), timeoutMs);
    socket.on('error', () => done(null));

    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== address) return;
      let packet;
      try {
        packet = dnsPacket.decode(msg);
      } catch {
        return;
      }
      const records = [...(packet.answers || []), ...(packet.additionals || [])];
      const ptr = records.find((r) => r.type === 'PTR' && r.name.toLowerCase() === SERVICE);
      if (!ptr) return;
      const instance = ptr.data;
      const srv = records.find((r) => r.type === 'SRV' && r.name === instance);
      const txt = parseTxt(records.find((r) => r.type === 'TXT' && r.name === instance)?.data);
      done({
        name: instance.slice(0, -(SERVICE.length + 1)) || instance,
        address,
        port: srv?.data?.port || DEFAULT_PORT,
        model: txt.rpMd || null,
      });
    });

    socket.bind(0, () => {
      const query = dnsPacket.encode({
        type: 'query',
        id: Math.floor(Math.random() * 0xffff),
        flags: 0,
        questions: [{ type: 'PTR', class: 'IN', name: SERVICE }],
      });
      socket.send(query, 5353, address, (err) => { if (err) done(null); });
    });
  });
}

module.exports = { scan, probe, isAppleTv, DEFAULT_PORT };
