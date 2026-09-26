/**
 * What Savant on the Pro Host is running.
 *
 *   runningConfig()     zones, components and their state variables in the configuration
 *                       uploaded from Blueprint (its userConfig.rpmConfig)
 *   configuredComponents()  every component in it, with its room, IP and MAC address and
 *                       state variables (the TV tools find Blueprint's TVs this way)
 *   sclibridgeZones()   the zones as Savant lists them (sclibridge userzones)
 *   savantZones()       the first of those that answers
 *   findSclibridge()    where sclibridge is
 *
 * Tests point these elsewhere with SPLYCEDBOARD_SAVANT_CONFIG and SPLYCEDBOARD_SCLIBRIDGE.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const SCLIBRIDGE_CANDIDATES = [
  '/Users/Shared/Savant/Applications/RacePointMedia/sclibridge',
  `${process.env.HOME}/Applications/RacePointMedia/sclibridge`,
  '/usr/local/bin/sclibridge',
];

// Where Savant keeps the configuration it runs: SavantOS 10 and later under /Users/Shared/Savant;
// older hosts, and a Mac running Blueprint, in the user's own Library.
const configDirs = () => (process.env.SPLYCEDBOARD_SAVANT_CONFIG
  ? [process.env.SPLYCEDBOARD_SAVANT_CONFIG]
  : [
    '/Users/Shared/Savant/Library/Application Support/RacePointMedia/userConfig.rpmConfig',
    path.join(os.homedir(), 'Library', 'Application Support', 'RacePointMedia', 'userConfig.rpmConfig'),
  ]);

/** A plist as plain data (plutil reads XML and binary plists alike), or null. */
function readPlist(file) {
  try {
    return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

function attributes(tag) {
  const out = {};
  for (const [, key, value] of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[key] = decode(value);
  return out;
}

/**
 * The configuration Savant is running, or null when there's none here (not a Pro Host):
 *   zones       [name]: its user zones (zoneConfig.xml)
 *   components  [{ manufacturer, model, name, deviceClass }] (zoneConfig.xml)
 *   variables   { component name: { state variable: value } }, as Blueprint set them
 *               (componentStateVariables.plist)
 * SavantOS 11 keeps zoneConfig.xml to Savant itself (_savant, mode 600). There, zones and
 * components are empty, and a component is told apart by its variables, which anyone can read.
 */
function runningConfig({ dir } = {}) {
  for (const d of dir ? [dir] : configDirs()) {
    let xml = null;
    try {
      xml = fs.readFileSync(path.join(d, 'zoneConfig.xml'), 'utf8');
    } catch { /* missing, or Savant's own */ }
    const stateVariables = readPlist(path.join(d, 'componentStateVariables.plist'));
    if (xml == null && !stateVariables) continue;
    const zones = [...(xml || '').matchAll(/<zone\s([^>]*)>/g)]
      .map((m) => attributes(m[1]))
      .filter((z) => z.type === 'user' && z.name)
      .map((z) => z.name);
    const components = [...(xml || '').matchAll(/<component\s([^>]*)>/g)]
      .map((m) => attributes(m[1]))
      .map((c) => ({ manufacturer: c.manufacturer || '', model: c.model || '', name: c.user_defined_name || '', deviceClass: c.device_class || '' }));
    const variables = Object.fromEntries(Object.entries(stateVariables || {}).map(([name, v]) => [name, v?.InitialValues || {}]));
    return { dir: d, zones: [...new Set(zones)], components, variables };
  }
  return null;
}

/** Rows of an SQLite query as objects (macOS's sqlite3), or null when it can't be read. */
function sqliteRows(file, query) {
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', file, query], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const text = String(out).trim();
    return text ? JSON.parse(text) : [];
  } catch {
    return null;
  }
}

/**
 * Every component in the configuration Savant runs, with what Blueprint says about it:
 *   [{ name, zone, manufacturer, model, deviceType, address, mac, variables }]
 *   address, mac  its network connection's IP and MAC Address fields (componentConnections.plist)
 *   variables     its state variables as set in Blueprint (componentStateVariables.plist)
 * The list comes from serviceImplementation.sqlite (ZoneConfigComponents), which anyone can
 * read, or from zoneConfig.xml on hosts where Savant still lets us read that.
 * @returns { dir, components } or null when there's no configuration here
 */
function configuredComponents({ dir } = {}) {
  for (const d of dir ? [dir] : configDirs()) {
    let rows = null;
    const db = path.join(d, 'serviceImplementation.sqlite');
    if (fs.existsSync(db)) {
      rows = sqliteRows(db, 'SELECT component, zone, manufacturer, model, deviceType FROM ZoneConfigComponents')
        ?.map((r) => ({ name: r.component, zone: r.zone || '', manufacturer: r.manufacturer || '', model: r.model || '', deviceType: r.deviceType || '' }));
    }
    if (!rows) {
      let xml = null;
      try {
        xml = fs.readFileSync(path.join(d, 'zoneConfig.xml'), 'utf8');
      } catch { /* missing, or Savant's own */ }
      if (xml != null) {
        rows = [...xml.matchAll(/<component\s([^>]*)>/g)]
          .map((m) => attributes(m[1]))
          .filter((c) => c.user_defined_name)
          .map((c) => ({ name: c.user_defined_name, zone: '', manufacturer: c.manufacturer || '', model: c.model || '', deviceType: c.device_class || '' }));
      }
    }
    if (!rows) continue;

    const connections = readPlist(path.join(d, 'componentConnections.plist')) || [];
    const stateVariables = readPlist(path.join(d, 'componentStateVariables.plist')) || {};
    const isSwitch = new Set(rows.filter((r) => /network_device/i.test(r.deviceType)).map((r) => r.name));
    const network = new Map(); // component name → { address, mac }
    for (const c of Array.isArray(connections) ? connections : []) {
      const address = String(c?.RPMComponentConnectionHostAddress || '').trim();
      if (!address) continue;
      // The address is the device's: the cable's sink end (Blueprint draws them from the
      // switch to the device), unless that end is the switch.
      const sink = c.RPMComponentConnectionSinkInfo?.RPMComponentIdentifier;
      const source = c.RPMComponentConnectionSourceInfo?.RPMComponentIdentifier;
      const name = sink && !isSwitch.has(sink) ? sink : source && !isSwitch.has(source) ? source : null;
      if (!name || network.has(name)) continue;
      network.set(name, { address, mac: String(c.RPMComponentConnectionMacAddress || '').trim() || null });
    }
    const seen = new Set();
    const components = rows.filter((r) => r.name && !seen.has(r.name) && seen.add(r.name)).map((r) => ({
      ...r,
      address: network.get(r.name)?.address || null,
      mac: network.get(r.name)?.mac || null,
      variables: stateVariables[r.name]?.InitialValues || {},
    }));
    return { dir: d, components };
  }
  return null;
}

/**
 * The profile a component uses, from the copies Savant keeps with its configuration
 * (componentProfiles/), matched by the profile's own manufacturer and model.
 * @returns the profile's XML, or null
 */
function componentProfile({ dir, manufacturer, model }) {
  const folder = path.join(dir, 'componentProfiles');
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.xml'));
  } catch {
    return null;
  }
  const want = (s) => String(s || '').trim().toLowerCase();
  // Savant names profile files after the same two attributes; try that one first.
  const named = `${want(manufacturer)}_${want(model)}.xml`;
  files.sort((a, b) => (b.toLowerCase() === named) - (a.toLowerCase() === named));
  for (const f of files) {
    const file = path.join(folder, f);
    // Profiles run to hundreds of KB: match on the root element, read the whole one only.
    let head = '';
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(8192);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } catch {
      continue;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    const root = head.match(/<component\s([^>]*)>/);
    const a = root ? attributes(root[1]) : {};
    if (want(a.manufacturer) !== want(manufacturer) || want(a.model) !== want(model)) continue;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

/** When the configuration Savant runs last changed (its newest file), for noticing uploads. */
function configStamp({ dir } = {}) {
  for (const d of dir ? [dir] : configDirs()) {
    let newest = 0;
    for (const f of ['serviceImplementation.sqlite', 'componentConnections.plist', 'componentStateVariables.plist', 'zoneConfig.xml']) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(d, f)).mtimeMs);
      } catch { /* not there */ }
    }
    if (newest) return `${d}@${newest}`;
  }
  return null;
}

function findSclibridge(candidates = SCLIBRIDGE_CANDIDATES) {
  const list = process.env.SPLYCEDBOARD_SCLIBRIDGE ? [process.env.SPLYCEDBOARD_SCLIBRIDGE] : candidates;
  return list.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

/** Zone names in Savant's order, from `sclibridge userzones` (one per line). */
function sclibridgeZones({ sclibridge = findSclibridge(), timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!sclibridge) {
      reject(httpError(404, "This Mac has no Savant configuration or sclibridge, so Savant's zones can't be read here. Type them in instead."));
      return;
    }
    execFile(sclibridge, ['userzones'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const failure = err ? (String(stderr || '').trim() || err.message) : lines.find((l) => /^error\b/i.test(l));
      if (failure) {
        reject(httpError(502, `Savant didn't answer (sclibridge userzones: ${failure}). Is its configuration running?`));
      } else if (!lines.length) {
        reject(httpError(502, "Savant didn't list any zones. Is a configuration running on this host?"));
      } else {
        resolve([...new Set(lines)]);
      }
    });
  });
}

/** Savant's zones: { zones, source: 'blueprint' (the running configuration) | 'savant' (sclibridge) }. */
async function savantZones() {
  const config = runningConfig();
  if (config?.zones.length) return { zones: config.zones, source: 'blueprint' };
  return { zones: await sclibridgeZones(), source: 'savant' };
}

module.exports = {
  SCLIBRIDGE_CANDIDATES, findSclibridge, runningConfig, configuredComponents, componentProfile, configStamp,
  sclibridgeZones, savantZones,
};
