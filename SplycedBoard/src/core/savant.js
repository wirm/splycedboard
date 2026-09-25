/**
 * What Savant on the Pro Host is running.
 *
 *   runningConfig()     zones and components of the configuration uploaded from Blueprint,
 *                       read from zoneConfig.xml in its userConfig.rpmConfig
 *   sclibridgeZones()   the zones as Savant lists them (sclibridge userzones)
 *   savantZones()       the first of those that answers
 *   findSclibridge()    where sclibridge is
 *
 * Tests point these elsewhere with SPLYCEDBOARD_SAVANT_CONFIG and SPLYCEDBOARD_SCLIBRIDGE.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCLIBRIDGE_CANDIDATES = [
  '/Users/Shared/Savant/Applications/RacePointMedia/sclibridge',
  `${process.env.HOME}/Applications/RacePointMedia/sclibridge`,
  '/usr/local/bin/sclibridge',
];

const configDir = () => process.env.SPLYCEDBOARD_SAVANT_CONFIG
  || path.join(os.homedir(), 'Library', 'Application Support', 'RacePointMedia', 'userConfig.rpmConfig');

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
 * The configuration Savant is running: { zones: [name], components: [{ manufacturer, model,
 * name, deviceClass }] }, or null when there's none here (not a Pro Host).
 */
function runningConfig({ dir = configDir() } = {}) {
  let xml;
  try {
    xml = fs.readFileSync(path.join(dir, 'zoneConfig.xml'), 'utf8');
  } catch {
    return null;
  }
  const zones = [...xml.matchAll(/<zone\s([^>]*)>/g)]
    .map((m) => attributes(m[1]))
    .filter((z) => z.type === 'user' && z.name)
    .map((z) => z.name);
  const components = [...xml.matchAll(/<component\s([^>]*)>/g)]
    .map((m) => attributes(m[1]))
    .map((c) => ({ manufacturer: c.manufacturer || '', model: c.model || '', name: c.user_defined_name || '', deviceClass: c.device_class || '' }));
  return { zones: [...new Set(zones)], components };
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

module.exports = { SCLIBRIDGE_CANDIDATES, findSclibridge, runningConfig, sclibridgeZones, savantZones };
