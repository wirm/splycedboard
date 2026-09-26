/**
 * Which year a Samsung TV is from, and so how it can be controlled.
 *
 * Tizen TVs say it outright: their model code starts with the year ("18_KANTM2_FRAME").
 * Otherwise the model number tells, by the letter Samsung gives each year: UN46D7000 (2011),
 * UN32F6300 (2013), UN55KS8000 (2016), UN65TU8000 (2020), QN65Q60T (2020), QN65QN90A (2021),
 * QN55LS03B (The Frame, 2022), QN65S95C (2023), U8000F (2025)…
 */

// Old-style model numbers: a letter (and maybe a second) before the series digits.
const LEADING = { C: 2010, D: 2011, E: 2012, F: 2013, H: 2014, J: 2015, K: 2016, M: 2017, N: 2018, R: 2019, T: 2020, A: 2021, B: 2022 };
// QLED, OLED and lifestyle models: a letter after the series digits.
const TRAILING = { N: 2018, R: 2019, T: 2020, A: 2021, B: 2022, C: 2023, D: 2024, F: 2025 };

function yearFromApiModel(code) {
  const m = /^(\d{2})_/.exec(String(code || ''));
  return m ? 2000 + Number(m[1]) : null;
}

// LCD (LN, LE) and plasma (PN, PS) sets of 2007–2014: LN-T3253H (2007), LN32A550 (2008)…
const OLD_PANELS = { T: 2007, A: 2008, B: 2009, C: 2010, D: 2011, E: 2012, F: 2013, H: 2014 };

function yearFromModel(model) {
  // Blueprint's profile names: "TV (2025)", and "(XX)" where the screen size goes
  const named = /\((20\d\d)\)/.exec(String(model || ''));
  if (named) return Number(named[1]);
  const raw = String(model || '').toUpperCase().replace(/\(X+\)/g, '65').replace(/[\s-]+/g, '');
  let m;
  if ((m = /^(?:LN|LE|PN|PS)\d{0,3}([A-Z])/.exec(raw))) return OLD_PANELS[m[1]] ?? null;
  // Drop the region prefix and the screen size: QN65QN90AAFXZA → QN90AAFXZA
  const s = raw
    .replace(/^(?:UN|UE|UA|QN|QE|QA|GQ|GU|LH|HG|KQ|KU|KS|TQ|UH|MR)(?=\d)/, '')
    .replace(/^\d{2,3}/, '');
  if (!s) return null;
  if (/^LS003/.test(s)) return 2017; // the first Frame
  if ((m = /^LS0?0?\d{1,2}([A-Z])/.exec(s))) return TRAILING[m[1]] ?? null; // The Frame, Serif, Sero
  if ((m = /^LST\d([A-Z])/.exec(s))) return TRAILING[m[1]] ?? null; // The Terrace
  if ((m = /^Q(\d)F(N)?/.exec(s))) return m[2] ? 2018 : 2017; // Q7F (2017), Q7FN (2018)
  if (/^Q\dC/.test(s)) return 2017; // Q7C, Q8C
  if ((m = /^(?:QN|Q|S)\d{2,3}([A-Z])/.exec(s))) return TRAILING[m[1]] ?? null; // Q60T, QN90A, S95C
  if ((m = /^U\d{4}([A-Z])/.exec(s))) return TRAILING[m[1]] ?? null; // U8000F (2025)
  if ((m = /^([A-Z])([A-Z])?\d{3,4}/.exec(s))) {
    const [, first, second] = m;
    if (first === 'C') return second === 'U' ? 2023 : 2010;
    if (first === 'D') return second === 'U' ? 2024 : 2011;
    return LEADING[first] ?? null;
  }
  return null;
}

/**
 * The generations, oldest first, and how SplycedBoard talks to each.
 * `ipControl` is what Savant's own IP profiles use (and what needs the AccessToken).
 */
function generation(year) {
  if (!year) return null;
  if (year >= 2020) return 'ip-control';
  if (year >= 2016) return 'smart-view';
  return 'legacy';
}

module.exports = { yearFromApiModel, yearFromModel, generation };
