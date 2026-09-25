/** Color helpers shared by the HTTP and telnet paths. */

/** RGB (0–255 each) → { hue: 0–360, saturation: 0–100 } */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue: Math.round(hue), saturation: Math.round(max === 0 ? 0 : (delta / max) * 100) };
}

/** Savant CCT slider position (0–100) → Kelvin (warmest 1400 K … coolest 10000 K). */
function cctLevelToKelvin(level) {
  return Math.round(1400 + (level / 100) * (10000 - 1400));
}

module.exports = { rgbToHsv, cctLevelToKelvin };
