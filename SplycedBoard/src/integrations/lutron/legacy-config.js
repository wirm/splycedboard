/**
 * One-time import of pairing data from the standalone bridge that SplycedBoard
 * replaces, so an upgraded host keeps talking to its processor without re-pairing.
 *
 *   ~/Library/Application Support/savant-lutron/   (savant-lutron-bridge v2)
 *   ~/savant-leap/config/                           (savant-lutron-bridge v1)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_DIRS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'savant-lutron'),
  path.join(os.homedir(), 'savant-leap', 'config'),
];

function migrateLegacyConfig({ settings, certDir, log, legacyDirs = LEGACY_DIRS }) {
  if (settings.exists()) return false;

  for (const dir of legacyDirs) {
    const legacyFile = path.join(dir, 'settings.json');
    if (!fs.existsSync(legacyFile)) continue;

    try {
      const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));

      const legacyCerts = path.join(dir, 'certs');
      if (fs.existsSync(legacyCerts)) {
        fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
        for (const f of fs.readdirSync(legacyCerts)) {
          const dest = path.join(certDir, f);
          if (!fs.existsSync(dest)) fs.copyFileSync(path.join(legacyCerts, f), dest);
        }
      }

      settings.save(legacy);
      log.info(`Imported pairing and settings from ${dir}`);
      return true;
    } catch (err) {
      log.warn(`Could not import settings from ${dir}: ${err.message}`);
    }
  }
  return false;
}

module.exports = { migrateLegacyConfig, LEGACY_DIRS };
