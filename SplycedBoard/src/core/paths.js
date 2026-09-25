/**
 * Filesystem locations used by the hub.
 *
 *   APP_DIR      — the code root (where package.json lives). When installed this is
 *                  ~/Library/Application Support/SplycedBoard; in development it is the repo.
 *   HOME_DIR     — the installed SplycedBoard folder (also the ~/Desktop/SplycedBoard link target).
 *   DATA_DIR     — settings + certificates. Kept outside the synced code so updates never touch it.
 *   LOG_DIR      — rotating log files. Only set when running as the launchd service.
 *
 * Every location can be overridden with an environment variable, which the tests use to
 * run against a throwaway directory.
 */
const os = require('os');
const path = require('path');

const APP_NAME = 'SplycedBoard';

const APP_DIR = path.resolve(__dirname, '..', '..');

const HOME_DIR = process.env.SPLYCEDBOARD_HOME
  || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', APP_NAME)
    : path.join(os.homedir(), '.config', 'splycedboard'));

const DATA_DIR = process.env.SPLYCEDBOARD_DATA_DIR || path.join(HOME_DIR, 'data');
const LOG_DIR = process.env.SPLYCEDBOARD_LOG_DIR || null;

const PUBLIC_DIR = path.join(APP_DIR, 'public');
const PROFILES_DIR = path.join(APP_DIR, 'profiles');
const INTEGRATIONS_DIR = path.join(APP_DIR, 'src', 'integrations');

module.exports = {
  APP_NAME,
  APP_DIR,
  HOME_DIR,
  DATA_DIR,
  LOG_DIR,
  PUBLIC_DIR,
  PROFILES_DIR,
  INTEGRATIONS_DIR,
};
