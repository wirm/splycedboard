/**
 * Discovers Lutron LEAP processors on the local network via mDNS/Bonjour.
 * Lutron devices advertise _lutron._tcp (Caseta) and _leap._tcp (QSX/RA3).
 *
 * Returns early (after a 1s grace period) if anything is found, so the UI
 * doesn't always wait the full timeout. Hard cap at timeoutMs.
 */
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPES = ['_lutron._tcp', '_leap._tcp'];
const EARLY_RETURN_GRACE_MS = 1000; // wait 1s after first find for stragglers

function discoverProcessors(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = new Map(); // id -> processor info
    let earlyTimer = null;
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      if (earlyTimer) clearTimeout(earlyTimer);
      browsers.forEach((b) => b?.stop());
      bonjour.destroy();
      resolve(Array.from(found.values()));
    }

    // Hard timeout
    const hardTimer = setTimeout(finish, timeoutMs);

    function onUp(service) {
      const host = service.addresses?.[0] || service.host?.replace(/\.$/, '');
      if (!host) return;

      const id = `${host}:${service.port}`;
      if (!found.has(id)) {
        const processor = {
          id,
          name: service.name || service.host,
          host,
          port: service.port || 8081,
          type: service.type,
          fqdn: service.fqdn || service.host,
          addresses: service.addresses || [host],
        };
        found.set(id, processor);
        console.log(`[discovery] Found: ${processor.name} at ${host}:${processor.port}`);

        // Schedule early return after grace period (reset on each new find)
        if (earlyTimer) clearTimeout(earlyTimer);
        earlyTimer = setTimeout(() => {
          clearTimeout(hardTimer);
          finish();
        }, EARLY_RETURN_GRACE_MS);
      }
    }

    const browsers = SERVICE_TYPES.map((type) => {
      try {
        const browser = bonjour.find({ type: type.replace(/^_/, '').replace(/\._tcp$/, '') });
        browser.on('up', onUp);
        return browser;
      } catch {
        return null;
      }
    });
  });
}

module.exports = { discoverProcessors };
