/**
 * File logging: rotation, and recovering when the log file is deleted underneath us.
 * Runs the logger in a child process — the test harness keeps logging in-memory only.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LOG_MODULE = path.join(__dirname, '..', 'SplycedBoard', 'src', 'core', 'log.js');

function runLogger(dir, script) {
  const code = `
    const fs = require('fs');
    const logger = require(${JSON.stringify(LOG_MODULE)});
    logger.configureFile(${JSON.stringify(dir)}, { maxBytes: 400, keep: 2 });
    const log = logger.createLogger('test');
    ${script}
  `;
  execFileSync(process.execPath, ['-e', code], { env: { ...process.env, SPLYCEDBOARD_LOG_SILENT: '' } });
}

test('rotates at maxBytes and keeps the configured number of old files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-log-'));
  runLogger(dir, `for (let i = 0; i < 40; i++) log.info('line', i);`);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['splycedboard.log', 'splycedboard.log.1', 'splycedboard.log.2']);
  assert.match(fs.readFileSync(path.join(dir, 'splycedboard.log'), 'utf8'), /\[test\] line 39\n$/);
});

test('a deleted log file never leads to writes into someone else\'s file descriptor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-log-'));
  const other = path.join(dir, 'other.txt');
  runLogger(dir, `
    log.info('before delete');
    fs.unlinkSync(${JSON.stringify(path.join(dir, 'splycedboard.log'))});
    // Push past maxBytes so rotate() runs against the missing file...
    for (let i = 0; i < 20; i++) log.info('after delete', i);
    // ...then open another file, which could be handed the logger's old fd number.
    const fd = fs.openSync(${JSON.stringify(other)}, 'w');
    fs.writeSync(fd, 'mine');
    for (let i = 0; i < 20; i++) log.info('later', i);
    fs.closeSync(fd);
  `);
  assert.equal(fs.readFileSync(other, 'utf8'), 'mine');
  assert.match(fs.readFileSync(path.join(dir, 'splycedboard.log'), 'utf8'), /\[test\] later 19\n$/);
});
