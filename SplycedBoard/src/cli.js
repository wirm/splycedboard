/**
 * Helper commands for the installer. Uses only built-in modules, so it runs before
 * `npm/bun install` has fetched dependencies.
 *
 *   cli.js list                   integrations as JSON (manifest fields + enabled)
 *   cli.js choices                `id <tab> enabled(1|0) <tab> name` per integration
 *   cli.js set-enabled a,b        switch on exactly these integrations, the rest off
 *   cli.js profiles a,b           absolute paths of their Savant profiles, one per line
 */
const fs = require('fs');
const path = require('path');

const paths = require('./core/paths');
const { JsonStore } = require('./core/store');
const registry = require('./integrations');

const hubSettings = new JsonStore(path.join(paths.DATA_DIR, 'hub.json'), { integrations: {} });

function isEnabled(manifest, saved) {
  const flag = saved.integrations?.[manifest.id]?.enabled;
  return typeof flag === 'boolean' ? flag : manifest.defaultEnabled !== false;
}

function parseIds(arg) {
  const known = new Set(registry.manifests().map((m) => m.id));
  const ids = (arg || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Unknown integration "${id}" (known: ${[...known].join(', ')})`);
  }
  return ids;
}

const commands = {
  list() {
    const saved = hubSettings.load();
    const list = registry.manifests().map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      profile: m.profile || null,
      enabled: isEnabled(m, saved),
    }));
    process.stdout.write(JSON.stringify(list, null, 2) + '\n');
  },

  /** Tab-separated `id  enabled(1|0)  name` lines, easy to read from bash. */
  choices() {
    const saved = hubSettings.load();
    for (const m of registry.manifests()) {
      process.stdout.write(`${m.id}\t${isEnabled(m, saved) ? 1 : 0}\t${m.name}\n`);
    }
  },

  'set-enabled'(arg) {
    const on = new Set(parseIds(arg));
    hubSettings.update((s) => {
      s.integrations = s.integrations || {};
      for (const m of registry.manifests()) {
        s.integrations[m.id] = { ...s.integrations[m.id], enabled: on.has(m.id) };
      }
    });
  },

  profiles(arg) {
    const ids = new Set(parseIds(arg));
    for (const m of registry.manifests()) {
      if (!ids.has(m.id) || !m.profile) continue;
      const file = path.join(paths.PROFILES_DIR, m.profile);
      if (fs.existsSync(file)) process.stdout.write(file + '\n');
    }
  },
};

const [cmd, arg] = process.argv.slice(2);
if (!commands[cmd]) {
  process.stderr.write(`usage: cli.js ${Object.keys(commands).join(' | ')}\n`);
  process.exit(2);
}
try {
  commands[cmd](arg);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
