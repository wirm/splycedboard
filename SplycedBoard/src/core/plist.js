/**
 * Minimal Apple property-list (XML) writer, for files Savant Blueprint imports
 * (lighting tables, etc.). Output is tab-indented like Blueprint's own exports.
 */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function node(value, depth) {
  const pad = '\t'.repeat(depth);

  if (value === true) return `${pad}<true/>`;
  if (value === false) return `${pad}<false/>`;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${pad}<integer>${value}</integer>` : `${pad}<real>${value}</real>`;
  }
  if (typeof value === 'string') return `${pad}<string>${esc(value)}</string>`;

  if (Array.isArray(value)) {
    if (!value.length) return `${pad}<array/>`;
    return [`${pad}<array>`, ...value.map((v) => node(v, depth + 1)), `${pad}</array>`].join('\n');
  }

  if (value && typeof value === 'object') {
    const lines = [`${pad}<dict>`];
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      lines.push(`${pad}\t<key>${esc(key)}</key>`, node(v, depth + 1));
    }
    lines.push(`${pad}</dict>`);
    return lines.join('\n');
  }

  throw new TypeError(`Cannot write ${typeof value} to a plist`);
}

function toPlist(root) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    node(root, 0),
    '</plist>',
  ].join('\n');
}

module.exports = { toPlist };
