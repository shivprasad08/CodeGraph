// WCAG 2.1 contrast helpers. Used by the token contrast tests.

/** Parses "#RRGGBB" or "rgba(r, g, b, a)" into { r, g, b, a } (0–255, alpha 0–1). */
export function parseColor(value) {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  }
  throw new Error(`Unsupported colour: ${value}`);
}

/** Alpha-composites a (possibly translucent) colour over an opaque background. */
export function composite(fg, bg) {
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function channel(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio of a foreground colour over an opaque background (strings or parsed). */
export function contrastRatio(foreground, background) {
  const bg = typeof background === 'string' ? parseColor(background) : background;
  const fgRaw = typeof foreground === 'string' ? parseColor(foreground) : foreground;
  const fg = fgRaw.a < 1 ? composite(fgRaw, bg) : fgRaw;
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
