/**
 * Which Savant Blueprint zones each Lutron area's lights go in, for the Blueprint lighting
 * export. A light can be in more than one zone.
 *
 * Lutron areas nest (Main Floor › Primary Suite › Bath) and their names repeat: every suite
 * can have a "Bath". Savant zones are one flat list. Each Lutron area that has lights gets a
 * suggested Savant zone, the strongest reason first:
 *
 *   exact     the same name, ignoring case and punctuation       Living Room → Living Room
 *   words     the same words, ignoring "room" and the like,       Living Room → Living
 *             abbreviations, and Master/Primary/Owner's           Mstr Bath   → Primary Bathroom
 *   path      the name plus where it sits in Lutron              Primary Suite › Bath → Master Bath
 *   part      one name is part of the other                      Kitchen Island → Kitchen
 *   spelling  nearly the same spelling                           Kitchn → Kitchen
 *   shared    a word in common: never applied by itself          Primary Suite ~ Master Bath
 *
 * A suggestion goes in its zone by itself ("auto") only when it is clearly the best and the
 * area's name is unique. Areas that share a name, close calls and weak matches wait for a
 * person ("review").
 *
 * What a person changes is kept per Savant zone, on top of the automatic matches:
 *   overrides[zone] = { addAreas: [areaId], removeAreas: [areaId], addLights: [lightId] }
 * so new automatic matches still arrive in a zone that was edited. Areas a person chose to
 * leave out on purpose (exported under their Lutron names) are listed in `kept`.
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

/** How well a Savant zone fits a Lutron area: { score 0–1, how }. */
function compare(area, zone) {
  if (area.norm === zone.norm) return { score: 1, how: 'exact' };
  const aw = area.words;
  const zw = zone.words;
  if (sameSet(aw, zw)) return { score: 0.95, how: 'words' };
  // The name plus its place in Lutron: every word of the Savant zone is in the area's name
  // or one of its parents', and the area's own words are all among them.
  if (zw.length > aw.length && aw.every((w) => zw.includes(w)) && zw.every((w) => area.pathWords.has(w))) {
    return { score: 0.9, how: 'path' };
  }
  const shared = zw.filter((w) => aw.includes(w)).length;
  if (shared === zw.length) return { score: 0.8 + 0.1 * (zw.length / aw.length), how: 'part' }; // Kitchen ⊂ Kitchen Island
  if (shared === aw.length) return { score: 0.75 + 0.1 * (aw.length / zw.length), how: 'part' }; // Guest ⊂ Guest Bedroom
  if (shared) return { score: 0.7 * ((2 * shared) / (aw.length + zw.length)), how: 'shared' }; // Primary Suite ~ Master Bath
  // Spelling only when no word is shared, so "Bedroom 1" never passes for "Bedroom 2".
  const alike = similarity(aw.join(' '), zw.join(' '));
  if (alike >= 0.85) return { score: Math.min(alike, 0.9), how: 'spelling' }; // Kitchn → Kitchen
  if (alike >= 0.8) return { score: 0.75 * alike, how: 'spelling' };
  return { score: 0, how: null };
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * The automatic side: every Lutron area with lights, where it sits, and its best Savant
 * zones. status: auto (goes in its suggestion by itself) | review | none.
 */
function suggest({ areas, lights, savantZones }) {
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

  const lightsOf = new Map();
  for (const l of lights) {
    if (l.areaId == null || !byId.has(l.areaId)) continue;
    if (!lightsOf.has(l.areaId)) lightsOf.set(l.areaId, []);
    lightsOf.get(l.areaId).push({ id: l.id, name: l.name });
  }

  const entries = [...lightsOf.keys()].map((id) => {
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

  const zones = savantZones.map((name) => ({ name, norm: normalize(name), words: words(name) }));

  const result = entries.map((e) => {
    const candidates = zones
      .map((z) => ({ zone: z.name, ...compare(e, z) }))
      .filter((c) => c.score >= 0.3) // weak ones still help a review: one click instead of a search
      .sort((a, b) => b.score - a.score)
      .map((c) => ({ ...c, score: round(c.score) }));
    const [best, second] = candidates;
    const twins = nameCount.get(e.key) - 1;
    const out = {
      areaId: e.area.id,
      name: e.area.name,
      path: e.path,
      lights: lightsOf.get(e.area.id),
      status: 'none',
      how: best?.how || null,
      suggestion: best || null,
      alternatives: candidates.slice(1, 4),
      reason: null,
    };
    if (!zones.length) return { ...out, reason: 'No Savant zones yet.' };
    if (!best) return { ...out, reason: `No Savant zone looks like "${e.area.name}".` };
    if (twins) {
      return { ...out, status: 'review', reason: `${twins + 1} Lutron areas are called "${e.area.name}". Check that this is the right Savant zone for this one.` };
    }
    if (best.score >= 0.95) return { ...out, status: 'auto' };
    if (best.score >= 0.8 && best.score - (second?.score ?? 0) >= 0.1) return { ...out, status: 'auto' };
    return {
      ...out,
      status: 'review',
      reason: second && best.score - second.score < 0.1
        ? `Could be "${best.zone}" or "${second.zone}".`
        : `Only a loose match for "${best.zone}".`,
    };
  });

  const order = (r) => [...r.path, r.name].join('\u0000');
  return result.sort((a, b) => order(a).localeCompare(order(b), undefined, { numeric: true }));
}

/**
 * Everything the Rooms tab and the export need.
 *
 * @param areas         Lutron areas: { id, name, parentId }
 * @param lights        the Lutron loads being exported: { id, name, areaId }
 * @param savantZones   Savant's zone names, in Savant's order
 * @param overrides     per zone: { addAreas, removeAreas, addLights } (see top)
 * @param kept          areas left out on purpose
 * @returns {
 *   zones:  [{ name, areas: [{ areaId, whole, lightIds, auto }], lights }],   Savant's order
 *   areas:  [{ areaId, name, path, lights: [{ id, name }], zones: { [zone]: [lightId] },
 *              placed, kept, status, how, suggestion, alternatives, reason }], tree order
 *   counts: { zones, areas, placed, waiting, unmatched, kept },
 *   zonesOf(lightId) → [zone]   for the export
 * }
 */
function buildRooms({ areas, lights, savantZones = [], overrides = {}, kept = [] }) {
  const suggested = suggest({ areas, lights, savantZones });
  const byArea = new Map(suggested.map((a) => [a.areaId, a]));
  const areaOfLight = new Map(suggested.flatMap((a) => a.lights.map((l) => [l.id, a.areaId])));
  const keptSet = new Set(kept);
  const autoIn = (zone) => suggested.filter((a) => a.status === 'auto' && a.suggestion.zone === zone).map((a) => a.areaId);

  const zones = savantZones.map((name) => {
    const o = overrides[name] || {};
    const auto = autoIn(name);
    const removed = new Set(o.removeAreas || []);
    const whole = [...new Set([...auto, ...(o.addAreas || [])])].filter((id) => byArea.has(id) && !removed.has(id));
    const partly = new Map();
    for (const id of o.addLights || []) {
      const areaId = areaOfLight.get(id);
      if (areaId == null || whole.includes(areaId)) continue;
      if (!partly.has(areaId)) partly.set(areaId, []);
      partly.get(areaId).push(id);
    }
    const inZone = [
      ...whole.map((areaId) => ({
        areaId,
        whole: true,
        lightIds: byArea.get(areaId).lights.map((l) => l.id),
        auto: auto.includes(areaId) && !(o.addAreas || []).includes(areaId),
      })),
      ...[...partly].map(([areaId, lightIds]) => ({ areaId, whole: false, lightIds, auto: false })),
    ];
    const rank = new Map(suggested.map((a, i) => [a.areaId, i]));
    inZone.sort((a, b) => rank.get(a.areaId) - rank.get(b.areaId));
    return { name, areas: inZone, lights: inZone.reduce((n, a) => n + a.lightIds.length, 0) };
  });

  const placements = new Map(suggested.map((a) => [a.areaId, {}]));
  const zonesOfLight = new Map();
  for (const z of zones) {
    for (const a of z.areas) {
      placements.get(a.areaId)[z.name] = a.lightIds;
      for (const id of a.lightIds) {
        if (!zonesOfLight.has(id)) zonesOfLight.set(id, []);
        zonesOfLight.get(id).push(z.name);
      }
    }
  }

  const listed = suggested.map((a) => {
    const zonesIn = placements.get(a.areaId);
    const placed = Object.keys(zonesIn).length > 0;
    let { reason } = a;
    if (!placed && a.status === 'auto') reason = `Taken out of "${a.suggestion.zone}".`;
    if (!placed && keptSet.has(a.areaId)) reason = 'Left out on purpose: exported under its Lutron name.';
    return { ...a, zones: zonesIn, placed, kept: !placed && keptSet.has(a.areaId), reason: placed ? null : reason };
  });

  const counts = { zones: savantZones.length, areas: listed.length, placed: 0, waiting: 0, unmatched: 0, kept: 0 };
  for (const a of listed) {
    if (a.placed) counts.placed++;
    else if (a.kept) counts.kept++;
    else if (a.status === 'review') counts.waiting++;
    else if (a.status === 'none') counts.unmatched++;
  }

  return { zones, areas: listed, counts, zonesOf: (lightId) => zonesOfLight.get(lightId) || [] };
}

/**
 * A person's selection for one zone ({ areas: whole areas, lights: single lights }) as the
 * difference from the automatic matches, which is what gets stored.
 */
function overrideFor(zone, { areas = [], lights = [] }, current) {
  const auto = current.areas.filter((a) => a.status === 'auto' && a.suggestion.zone === zone).map((a) => a.areaId);
  const known = new Set(current.areas.map((a) => a.areaId));
  const chosen = new Set(areas.filter((id) => known.has(id)));
  const areaOfLight = new Map(current.areas.flatMap((a) => a.lights.map((l) => [l.id, a.areaId])));
  return {
    addAreas: [...chosen].filter((id) => !auto.includes(id)),
    removeAreas: auto.filter((id) => !chosen.has(id)),
    addLights: [...new Set(lights)].filter((id) => areaOfLight.has(id) && !chosen.has(areaOfLight.get(id))),
  };
}

module.exports = { buildRooms, overrideFor, words, normalize };
