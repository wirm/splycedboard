/**
 * Persistent config — stored in config/settings.json
 * Handles processor pairing data and certificates.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Store config in ~/Library/Application Support/savant-lutron on macOS,
// ~/.config/savant-lutron everywhere else. This survives reinstalls of the app.
const APP_SUPPORT = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'savant-lutron')
  : path.join(os.homedir(), '.config', 'savant-lutron');

const CONFIG_DIR = APP_SUPPORT;
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');
const CERTS_DIR = path.join(CONFIG_DIR, 'certs');

function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  _migrateOnce();
}

// One-time migration from the old in-project config/ directory (pre-v2 location)
function _migrateOnce() {
  const oldDir = path.join(__dirname, '..', 'config');
  const oldSettings = path.join(oldDir, 'settings.json');
  const oldCerts = path.join(oldDir, 'certs');
  const migrationFlag = path.join(CONFIG_DIR, '.migrated');

  if (fs.existsSync(migrationFlag) || !fs.existsSync(oldSettings)) return;

  try {
    // Copy settings.json
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.copyFileSync(oldSettings, CONFIG_FILE);
    }
    // Copy certs
    if (fs.existsSync(oldCerts)) {
      for (const f of fs.readdirSync(oldCerts)) {
        const dest = path.join(CERTS_DIR, f);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(oldCerts, f), dest);
        }
      }
    }
    fs.writeFileSync(migrationFlag, new Date().toISOString());
    console.log(`[config] Migrated config to ${CONFIG_DIR}`);
  } catch (err) {
    // Non-fatal — fresh install will just need to re-pair
    console.warn('[config] Migration skipped:', err.message);
  }
}

function load() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

function getCertPaths(processorId) {
  return {
    ca: path.join(CERTS_DIR, `${processorId}-ca.crt`),
    cert: path.join(CERTS_DIR, `${processorId}-client.crt`),
    key: path.join(CERTS_DIR, `${processorId}-client.key`),
  };
}

function saveCerts(processorId, { ca, cert, key }) {
  ensureDirs();
  const paths = getCertPaths(processorId);
  fs.writeFileSync(paths.ca, ca);
  fs.writeFileSync(paths.cert, cert);
  fs.writeFileSync(paths.key, key);
  return paths;
}

function loadCerts(processorId) {
  const paths = getCertPaths(processorId);
  try {
    return {
      ca: fs.readFileSync(paths.ca),
      cert: fs.readFileSync(paths.cert),
      key: fs.readFileSync(paths.key),
    };
  } catch {
    return null;
  }
}

function hasCerts(processorId) {
  const paths = getCertPaths(processorId);
  return fs.existsSync(paths.ca) && fs.existsSync(paths.cert) && fs.existsSync(paths.key);
}

module.exports = { load, save, saveCerts, loadCerts, hasCerts, getCertPaths };
