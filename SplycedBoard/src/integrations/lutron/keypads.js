/**
 * Which Lutron keypad a device is, and where its buttons sit on the faceplate, for the
 * dashboard to draw it with the same structure: seeTouch, Palladiom, Sunnata, Alisse, Pico,
 * or a plain column for anything else.
 *
 * LEAP gives each keypad a DeviceType ("SeeTouchKeypad", "PalladiomKeypad"…) and a
 * ModelNumber ("HQWD-W4S", "HQWT-U-PRW"…), and each button a ButtonNumber. The numbers are
 * positions: seeTouch buttons 1-7 run top to bottom, so a 4-scene seeTouch (1-4, then Off as
 * 6) keeps its gap. Raise/lower come in pairs: 16 lower / 17 raise, 18 lower / 19 raise (Pico:
 * 5 raise, 6 lower). They have no LED and no programming model of their own.
 */

const FAMILIES = [
  { id: 'seetouch', name: 'seeTouch', type: /seetouch/i, model: /^(HQ[WR]D|HW[DR]|HQRA?|RR?D|RRA)-/i, positional: true },
  { id: 'palladiom', name: 'Palladiom', type: /palladiom/i, model: /^(HQWT-U-P|HW-?PAL|HQWT-PAL)/i },
  { id: 'sunnata', name: 'Sunnata', type: /sunnata/i, model: /^[RH]RST-/i },
  { id: 'alisse', name: 'Alisse', type: /alisse/i, model: /^(HQWA|HWA|HQWT-U-A)/i },
  { id: 'pico', name: 'Pico', type: /pico/i, model: /^PJ\d?-/i },
];
const GENERIC = { id: 'generic', name: 'Keypad' };

/** The keypad family for a LEAP DeviceType and ModelNumber (either may be missing). */
function keypadFamily(deviceType = '', model = '') {
  const f = FAMILIES.find((x) => x.type.test(deviceType || '')) || FAMILIES.find((x) => x.model.test(model || ''));
  return f ? { id: f.id, name: f.name } : { ...GENERIC };
}

/** 'raise', 'lower' or 'button', from what the button says of itself, then its number. */
function buttonRole(button, familyId = 'generic') {
  const model = button.programmingModel || '';
  if (/raise/i.test(model)) return 'raise';
  if (/lower/i.test(model)) return 'lower';
  const text = String(button.engraving || '').trim();
  if (/^(raise|up|▲|\+)$/i.test(text)) return 'raise';
  if (/^(lower|down|▼|−|-)$/i.test(text)) return 'lower';
  const n = button.number;
  if (familyId === 'pico') return n === 5 ? 'raise' : n === 6 ? 'lower' : 'button';
  if (n === 17 || n === 19) return 'raise';
  if (n === 16 || n === 18) return 'lower';
  return 'button';
}

/**
 * The faceplate, top to bottom:
 *   { type: 'button', id }                  one button
 *   { type: 'gap' }                         an empty position (seeTouch)
 *   { type: 'pair', lower: id, raise: id }  a raise/lower pair, side by side; on a Pico each on its
 *                                           own row, either side of the favorite (the other null)
 */
function keypadLayout({ deviceType, model, buttons }) {
  const family = keypadFamily(deviceType, model);
  const byRole = { button: [], raise: [], lower: [] };
  for (const b of buttons) byRole[buttonRole(b, family.id)].push(b);
  const byNumber = (a, b) => (a.number ?? 99) - (b.number ?? 99);
  const regular = byRole.button.sort(byNumber);

  // Raise and lower meet in pairs: lower n with raise n+1 (16/17, 18/19), else in order.
  const lowers = byRole.lower.sort(byNumber);
  const raises = byRole.raise.sort(byNumber);
  const pairs = [];
  for (const lower of lowers) {
    const i = raises.findIndex((r) => r.number === lower.number + 1 || (family.id === 'pico' && r.number === lower.number - 1));
    pairs.push({ type: 'pair', lower: lower.id, raise: i >= 0 ? raises.splice(i, 1)[0].id : null });
  }
  for (const raise of raises) pairs.push({ type: 'pair', lower: null, raise: raise.id });

  const rows = [];
  if (family.id === 'pico') {
    // On, raise, favorite, lower, off: raise and lower either side of the favorite
    const [top, middle, ...rest] = regular;
    const [first = { raise: null, lower: null }, ...more] = pairs;
    const row = (b) => ({ type: 'button', id: b.id });
    if (top) rows.push(row(top));
    if (first.raise) rows.push({ type: 'pair', lower: null, raise: first.raise });
    if (middle) rows.push(row(middle));
    if (first.lower) rows.push({ type: 'pair', lower: first.lower, raise: null });
    rows.push(...rest.map(row), ...more);
    return { family, rows };
  }
  let last = null;
  for (const b of regular) {
    // seeTouch buttons keep their positions: a missing number is an empty slot
    if (family.id === 'seetouch' && last != null && b.number > last + 1 && b.number <= 7) rows.push({ type: 'gap' });
    rows.push({ type: 'button', id: b.id });
    last = b.number ?? last;
  }
  rows.push(...pairs);
  return { family, rows };
}

module.exports = { keypadFamily, keypadLayout, buttonRole, FAMILIES };
