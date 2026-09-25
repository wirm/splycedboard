/**
 * Which Savant room each Lutron area's lights go in, for the Blueprint lighting export.
 *
 * Lutron areas nest (Main Floor › Primary Suite › Bath) and their names repeat: every suite
 * can have a "Bath". Savant rooms are one flat list. Each Lutron area that has lights gets a
 * suggested Savant room, the strongest reason first:
 *
 *   exact     the same name, ignoring case and punctuation       Living Room → Living Room
 *   words     the same words, ignoring "room" and the like,       Living Room → Living
 *             abbreviations, and Master/Primary/Owner's           Mstr Bath   → Primary Bathroom
 *   path      the name plus where it sits in Lutron              Primary Suite › Bath → Master Bath
 *   part      one name is part of the other                      Kitchen Island → Kitchen
 *   spelling  nearly the same spelling                           Kitchn → Kitchen
 *   shared    a word in common: never applied by itself          Primary Suite ~ Master Bath
 *
 * A suggestion only applies by itself when it is clearly the best one and the area's name
 * is unique. Areas that share a name, close calls, weak matches, and earlier choices that
 * no longer fit Savant's rooms wait for the user ("review"). What the user picks always wins.
 */

const STOP_WORDS = new Set(['room', 'rooms', 'rm', 'the', 'area', 'zone', 'lights', 'lighting', 'and', 'of', 'a']);

// Spellings of the same thing, mapped to one word (or several).
const SAME = {
  bath: 'bathroom', bth: 'bathroom', bthrm: 'bathroom', ba: 'bathroom', washroom: 'bathroom', restroom: 'bathroom',
  bed: 'bedroom', bdrm: 'bedroom', bdr: 'bedroom', br: 'bedroom', bedrm: 'bedroom',
  master: 'primary', mstr: 'primary', mst: 'primary', owner: 'primary', owners: 'primary',
  liv: 'living', lvg: 'living', lr: 'living',
  fam: 'family', fr: 'family',
  din: 'dining', dng: 'dining', dr: 'dining',
  kit: 'kitchen', kitch: 'kitchen', ktchn: 'kitchen',
  gr: 'great',
  ofc: 'office', offc: 'office',
  gar: 'garage',
  laund: 'laundry', lndry: 'laundry',
  pwdr: 'powder', pwd: 'powder',
  ent: 'entry', entrance: 'entry', entryway: 'entry',
  hallway: 'hall', corridor: 'hall',
  stairs: 'stair', stairway: 'stair', staircase: 'stair',
  ext: 'exterior', outside: 'exterior', outdoor: 'exterior', outdoors: 'exterior',
  flr: 'floor', lvl: 'level', bsmt: 'basement', lwr: 'lower', upr: 'upper',
  mbr: 'primary bedroom', mbath: 'primary bathroom', mba: 'primary bathroom',
  first: '1', '1st': '1', one: '1',
  second: '2', '2nd': '2', two: '2',
  third: '3', '3rd': '3', three: '3',
  fourth: '4', '4th': '4', four: '4',
  fifth: '5', '5th': '5', five: '5',
};

const normalize = (name) => String(name ?? '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

function canonical(word) {
  if (SAME[word]) return SAME[word].split(' ');
  // "Bedrooms" → "bedroom", but not "glass" or "kids"
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) {
    const one = word.slice(0, -1);
    return SAME[one] ? SAME[one].split(' ') : [one];
  }
  return [word];
}

/** The words that identify a room, in a comparable form. */
function words(name) {
  const all = normalize(name).split(' ').filter(Boolean).flatMap(canonical);
  const kept = all.filter((w) => !STOP_WORDS.has(w));
  return [...new Set(kept.length ? kept : all)]; // "Room" alone stays "room"
}

const sameSet = (a, b) => a.length === b.length && a.every((w) => b.includes(w));

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a, b) => (a && b ? 1 - editDistance(a, b) / Math.max(a.length, b.length) : 0);

/** How well a Savant room fits a Lutron area: { score 0–1, how }. */
function compare(area, room) {
  if (area.norm === room.norm) return { score: 1, how: 'exact' };
  const aw = area.words;
  const rw = room.words;
  if (sameSet(aw, rw)) return { score: 0.95, how: 'words' };
  // The name plus its place in Lutron: every word of the Savant room is in the area's name
  // or one of its parents', and the area's own words are all among them.
  if (rw.length > aw.length && aw.every((w) => rw.includes(w)) && rw.every((w) => area.pathWords.has(w))) {
    return { score: 0.9, how: 'path' };
  }
  const shared = rw.filter((w) => aw.includes(w)).length;
  if (shared === rw.length) return { score: 0.8 + 0.1 * (rw.length / aw.length), how: 'part' }; // Kitchen ⊂ Kitchen Island
  if (shared === aw.length) return { score: 0.75 + 0.1 * (aw.length / rw.length), how: 'part' }; // Guest ⊂ Guest Bedroom
  if (shared) return { score: 0.7 * ((2 * shared) / (aw.length + rw.length)), how: 'shared' }; // Primary Suite ~ Master Bath
  // Spelling only when no word is shared, so "Bedroom 1" never passes for "Bedroom 2".
  const alike = similarity(aw.join(' '), rw.join(' '));
  if (alike >= 0.85) return { score: Math.min(alike, 0.9), how: 'spelling' }; // Kitchn → Kitchen
  if (alike >= 0.8) return { score: 0.75 * alike, how: 'spelling' };
  return { score: 0, how: null };
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * @param areas         Lutron areas: { id, name, parentId }
 * @param zones         the Lutron loads being exported: { id, name, areaId }
 * @param savantRooms   Savant's room names
 * @param decisions     the user's choices: { [areaId]: { zone } }; zone null keeps the Lutron name
 * @returns { rooms, counts }: rooms[i] = { areaId, name, path, loads, zone, status, how,
 *          suggestion, alternatives, reason }. zone is what the export uses (null: the
 *          Lutron name). status: exact | close | set | review | none.
 */
function mapRooms({ areas, zones, savantRooms = [], decisions = {} }) {
  const byId = new Map(areas.map((a) => [a.id, a]));

  // One area holding all the others is the project itself: it says nothing about rooms.
  // Several top-level areas (floors, say) do, and stay.
  const roots = areas.filter((a) => !byId.has(a.parentId));
  const project = roots.length === 1 ? roots[0].id : null;

  /** Parents' names, top first. */
  const pathOf = (area) => {
    const path = [];
    const seen = new Set([area.id]);
    let parent = byId.get(area.parentId);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (parent.id !== project) path.unshift(parent.name);
      parent = byId.get(parent.parentId);
    }
    return path;
  };

  const loads = new Map();
  for (const z of zones) {
    if (z.areaId == null) continue;
    if (!loads.has(z.areaId)) loads.set(z.areaId, []);
    loads.get(z.areaId).push(z.name);
  }

  const entries = [...loads.keys()].filter((id) => byId.has(id)).map((id) => {
    const area = byId.get(id);
    const path = pathOf(area);
    const own = words(area.name);
    return {
      area,
      path,
      norm: normalize(area.name),
      words: own,
      key: own.join(' '),
      pathWords: new Set([...own, ...path.flatMap(words)]),
    };
  });

  const nameCount = new Map();
  for (const e of entries) nameCount.set(e.key, (nameCount.get(e.key) || 0) + 1);

  const rooms = savantRooms.map((name) => ({ name, norm: normalize(name), words: words(name) }));
  const roomNames = new Set(savantRooms);

  const result = entries.map((e) => {
    const candidates = rooms
      .map((r) => ({ room: r.name, ...compare(e, r) }))
      .filter((c) => c.score >= 0.3) // weak ones still help the review: one click instead of a search
      .sort((a, b) => b.score - a.score)
      .map((c) => ({ ...c, score: round(c.score) }));
    const [best, second] = candidates;
    const twins = nameCount.get(e.key) - 1;
    const out = {
      areaId: e.area.id,
      name: e.area.name,
      path: e.path,
      loads: loads.get(e.area.id),
      zone: null,
      status: 'none',
      how: null,
      suggestion: best || null,
      alternatives: candidates.slice(best ? 1 : 0, 4),
      reason: null,
    };
    const decision = decisions[e.area.id] ?? decisions[String(e.area.id)];

    if (decision) {
      if (decision.zone === null || roomNames.has(decision.zone)) {
        return { ...out, zone: decision.zone, status: 'set' };
      }
      return { ...out, status: 'review', reason: `"${decision.zone}" isn't one of Savant's rooms any more.` };
    }
    if (!rooms.length) return { ...out, reason: 'No Savant rooms yet.' };
    if (!best) return { ...out, reason: `No Savant room looks like "${e.area.name}".` };
    if (twins) {
      return {
        ...out,
        status: 'review',
        how: best.how,
        reason: `${twins + 1} Lutron areas are called "${e.area.name}". Check that this is the right Savant room for this one.`,
      };
    }
    if (best.score >= 0.95) return { ...out, zone: best.room, status: 'exact', how: best.how };
    if (best.score >= 0.8 && best.score - (second?.score ?? 0) >= 0.1) {
      return { ...out, zone: best.room, status: 'close', how: best.how };
    }
    return {
      ...out,
      status: 'review',
      how: best.how,
      reason: second && best.score - second.score < 0.1
        ? `Could be "${best.room}" or "${second.room}".`
        : `Only a loose match for "${best.room}".`,
    };
  });

  result.sort((a, b) => [...a.path, a.name].join('\u0000').localeCompare([...b.path, b.name].join('\u0000'), undefined, { numeric: true }));
  const counts = { total: result.length, exact: 0, close: 0, set: 0, review: 0, none: 0 };
  for (const r of result) counts[r.status]++;
  return { rooms: result, counts };
}

module.exports = { mapRooms, words, normalize };
