/**
 * Asking Savant on the Pro Host, through sclibridge (Savant's command-line bridge).
 *
 *   findSclibridge()   where sclibridge is (SPLYCEDBOARD_SCLIBRIDGE overrides, for tests)
 *   savantRooms()      the rooms ("user zones") of the configuration Savant is running
 */
const fs = require('fs');
const { execFile } = require('child_process');

const SCLIBRIDGE_CANDIDATES = [
  '/Users/Shared/Savant/Applications/RacePointMedia/sclibridge',
  `${process.env.HOME}/Applications/RacePointMedia/sclibridge`,
  '/usr/local/bin/sclibridge',
];

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

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Room names in Savant's order, from `sclibridge userzones` (one per line). */
function savantRooms({ sclibridge = findSclibridge(), timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!sclibridge) {
      reject(httpError(404, "Savant's sclibridge isn't on this Mac, so its rooms can't be read here. Type them in instead."));
      return;
    }
    execFile(sclibridge, ['userzones'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const failure = err ? (String(stderr || '').trim() || err.message) : lines.find((l) => /^error\b/i.test(l));
      if (failure) {
        reject(httpError(502, `Savant didn't answer (sclibridge userzones: ${failure}). Is its configuration running?`));
      } else if (!lines.length) {
        reject(httpError(502, "Savant didn't list any rooms. Is a configuration running on this host?"));
      } else {
        resolve([...new Set(lines)]);
      }
    });
  });
}

module.exports = { SCLIBRIDGE_CANDIDATES, findSclibridge, savantRooms };
