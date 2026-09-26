/**
 * SplycedBoard — entry point.
 *
 * Runs on the Savant Pro Host as a launchd agent (see ./install). Loads every
 * integration in src/integrations, starts the ones that are switched on, and serves
 * the dashboard + APIs on port 47200.
 *
 * Environment (set by the launchd plist; all optional when running by hand):
 *   SPLYCEDBOARD_MANAGED=1     running under launchd, which restarts us when we exit
 *   SPLYCEDBOARD_LOG_DIR       write rotating logs here instead of the terminal
 *   SPLYCEDBOARD_HOME          install folder (default ~/Library/Application Support/SplycedBoard)
 *   SPLYCEDBOARD_WEB_PORT      dashboard port (default 47200)
 */
const logger = require('./core/log');
const paths = require('./core/paths');
const { Hub } = require('./core/hub');
const { Updater, githubRepo } = require('./core/updates');
const { createWebServer } = require('./web/server');
const pkg = require('../package.json');

const MANAGED = process.env.SPLYCEDBOARD_MANAGED === '1';

if (paths.LOG_DIR) logger.configureFile(paths.LOG_DIR);
const log = logger.createLogger('app');

process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection:', err));
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception — exiting:', err);
  process.exit(1); // launchd starts us again
});

async function main() {
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
  log.info(`${paths.APP_NAME} ${pkg.version} starting (${runtime}, pid ${process.pid}${MANAGED ? ', launchd' : ''})`);
  log.info(`Data folder: ${paths.DATA_DIR}`);

  const hub = new Hub();
  hub.load();

  // Checks GitHub for new releases; installs them only as the launchd service.
  const updates = new Updater({
    version: pkg.version,
    repo: githubRepo(pkg),
    dataDir: paths.DATA_DIR,
    logDir: paths.LOG_DIR,
    managed: MANAGED,
    log: logger.createLogger('update'),
  });
  if (MANAGED) updates.startAutoCheck();

  let web = null;
  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    log.info(`Shutting down (${reason})`);
    setTimeout(() => process.exit(0), 5000).unref(); // don't hang on a stuck socket
    updates.stop();
    await web?.close();
    await hub.stopAll();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Dashboard first, so it's reachable even while integrations are starting.
  web = await createWebServer({
    hub,
    updates,
    // Testing only: SPLYCEDBOARD_TRUST_LOCAL=0 asks this Mac for the password too.
    trustLocal: process.env.SPLYCEDBOARD_TRUST_LOCAL !== '0',
    app: {
      name: paths.APP_NAME,
      version: pkg.version,
      runtime,
      managed: MANAGED,
      startedAt: new Date().toISOString(),
      restart: () => shutdown('restart requested from dashboard'),
    },
  });

  await hub.startEnabled();
}

main().catch((err) => {
  log.error('Failed to start:', err);
  process.exit(1);
});
