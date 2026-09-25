/**
 * Hub logger.
 *
 *   const log = createLogger('lutron');
 *   log.info('Connected to', host);
 *   log.child('telnet').debug('→ savant', line);   // tag: lutron:telnet
 *
 * Every entry goes to three places:
 *   - the terminal (colourised when attached to a TTY), unless a log file is configured
 *   - a rotating log file (when running as the launchd service)
 *   - an in-memory ring buffer + listeners, which feed the dashboard's Logs page
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 1000;

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', green: '\x1b[32m', blue: '\x1b[34m',
};
const LEVEL_COLOR = { debug: COLORS.dim, info: COLORS.green, warn: COLORS.yellow, error: COLORS.red };
const TAG_COLORS = [COLORS.cyan, COLORS.magenta, COLORS.blue, COLORS.yellow, COLORS.green];

let minLevel = LEVELS.debug;
const ring = [];
const listeners = new Set();
let file = null; // { path, fd, size, maxBytes, keep }
const silent = process.env.SPLYCEDBOARD_LOG_SILENT === '1'; // tests: keep entries in memory only

function setVerbose(verbose) {
  minLevel = verbose ? LEVELS.debug : LEVELS.info;
}

const REOPEN_CHECK_MS = 30000;

/** Start writing to <dir>/splycedboard.log, rotating at maxBytes and keeping `keep` old files. */
function configureFile(dir, { maxBytes = 5 * 1024 * 1024, keep = 3 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  file = { path: path.join(dir, 'splycedboard.log'), fd: null, size: 0, maxBytes, keep, checkedAt: 0 };
  reopen();
}

/** (Re)open the log file. If that fails, fall back to stdout rather than keep a stale fd. */
function reopen() {
  if (file.fd !== null) {
    try { fs.closeSync(file.fd); } catch { /* already closed */ }
    file.fd = null;
  }
  try {
    file.fd = fs.openSync(file.path, 'a');
    file.size = fs.fstatSync(file.fd).size;
    file.checkedAt = Date.now();
  } catch {
    file = null;
  }
}

function rotate() {
  for (let i = file.keep - 1; i >= 1; i--) {
    try { fs.renameSync(`${file.path}.${i}`, `${file.path}.${i + 1}`); } catch { /* gap in the sequence */ }
  }
  try { fs.renameSync(file.path, `${file.path}.1`); } catch { /* file was removed */ }
  reopen();
}

/** Someone deleted or moved the log (e.g. via the Desktop folder)? Start a fresh one. */
function reopenIfMoved() {
  if (Date.now() - file.checkedAt < REOPEN_CHECK_MS) return;
  file.checkedAt = Date.now();
  try {
    if (fs.statSync(file.path).ino === fs.fstatSync(file.fd).ino) return;
  } catch { /* missing — reopen below */ }
  reopen();
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  return util.inspect(a, { depth: 4, breakLength: Infinity });
}

function tagColor(tag) {
  const root = tag.split(':')[0];
  let h = 0;
  for (const ch of root) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

function write(level, tag, args) {
  if (LEVELS[level] < minLevel) return;

  const now = new Date();
  const msg = args.map(formatArg).join(' ');
  const entry = { t: now.toISOString(), level, tag, msg };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  const time = now.toLocaleTimeString('en-US', { hour12: false });

  if (silent) {
    // in-memory only
  } else if (file) {
    const line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}\n`;
    try {
      reopenIfMoved();
      if (file) {
        fs.writeSync(file.fd, line);
        file.size += Buffer.byteLength(line);
        if (file.size > file.maxBytes) rotate();
      }
    } catch { /* never let logging take the service down */ }
  } else if (process.stdout.isTTY) {
    const c = COLORS;
    const out = `${c.dim}${time}${c.reset} ${LEVEL_COLOR[level]}${level.padEnd(5)}${c.reset} ${tagColor(tag)}[${tag}]${c.reset} ${msg}`;
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(out + '\n');
  } else {
    process.stdout.write(`${time} ${level.padEnd(5)} [${tag}] ${msg}\n`);
  }

  for (const fn of listeners) {
    try { fn(entry); } catch { /* listener errors are not our problem */ }
  }
}

function createLogger(tag) {
  return {
    tag,
    debug: (...a) => write('debug', tag, a),
    info: (...a) => write('info', tag, a),
    warn: (...a) => write('warn', tag, a),
    error: (...a) => write('error', tag, a),
    child: (sub) => createLogger(`${tag}:${sub}`),
  };
}

/** Subscribe to new entries. Returns an unsubscribe function. */
function onEntry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function recent(limit = RING_MAX) {
  return ring.slice(-limit);
}

module.exports = { createLogger, setVerbose, configureFile, onEntry, recent };
