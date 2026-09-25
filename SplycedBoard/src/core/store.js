/**
 * Small JSON file store with atomic writes.
 *
 * The hub keeps its own settings in data/hub.json, and every integration gets a
 * store at data/<id>/settings.json (see ctx.settings in core/hub.js).
 */
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
  }

  get dir() {
    return path.dirname(this.file);
  }

  exists() {
    return fs.existsSync(this.file);
  }

  load() {
    try {
      return { ...this.defaults, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      return { ...this.defaults };
    }
  }

  save(data) {
    fs.mkdirSync(this.dir, { recursive: true });
    // Write-then-rename so a crash mid-write can never leave a truncated file behind.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    return data;
  }

  /** Load, let `fn` mutate (or return a replacement), then save. */
  update(fn) {
    const data = this.load();
    return this.save(fn(data) ?? data);
  }
}

module.exports = { JsonStore };
