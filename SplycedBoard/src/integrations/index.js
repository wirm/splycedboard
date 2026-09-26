/**
 * Integration registry.
 *
 * Each integration lives in its own folder:
 *
 *   src/integrations/<id>/
 *     manifest.json   — id, name, description, Savant profile, ports (read without loading any code)
 *     index.js        — exports create(ctx) → instance with start/stop/status/router
 *     ui/panel.html   — optional dashboard panel (+ panel.js / panel.css)
 *
 * and its Savant profile in profiles/. To add an integration, create the folder and
 * add its id below. See docs/ADDING-AN-INTEGRATION.md.
 */
const fs = require('fs');
const path = require('path');

const INTEGRATIONS = [
  'lutron',
  'appletv',
  'scli',
  // Tools (manifest "category": "tool"): the dashboard lists them under Tools
  'samsungtv',
  'lgtv',
  'sonytv',
];

function manifests() {
  return INTEGRATIONS.map((id) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, id, 'manifest.json'), 'utf8'));
    if (manifest.id !== id) throw new Error(`Integration folder "${id}" has manifest id "${manifest.id}"`);
    const uiFile = (name) => fs.existsSync(path.join(__dirname, id, 'ui', name));
    return {
      ...manifest,
      // Which dashboard panel files exist, so the dashboard never requests a missing one.
      ui: uiFile('panel.html') ? { js: uiFile('panel.js'), css: uiFile('panel.css') } : null,
    };
  });
}

function load(id) {
  return require(`./${id}`);
}

module.exports = { manifests, load };
