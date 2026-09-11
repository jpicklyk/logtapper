/**
 * WCAG 2.x relative luminance + contrast ratio (sRGB), plus a colour parser
 * covering the CSS forms tokens.css actually uses: #rgb, #rrggbb,
 * #rrggbbaa, and rgb()/rgba(). No framework dependency — consumed by
 * contrast.test.ts and tokens.contrast.test.ts.
 */

export interface Rgb {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_FN_RE = /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*(?:,\s*[\d.]+%?\s*)?\)$/i;

function channelFromPercentOrNumber(raw: string): number {
  if (raw.endsWith('%')) {
    return Math.round((parseFloat(raw) / 100) * 255);
  }
  return Math.round(parseFloat(raw));
}

/** Parses a hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa) or rgb()/rgba() into 0-255 channels. Alpha is ignored — contrast math is defined for opaque colours. */
export function hexToRgb(input: string): Rgb {
  const value = input.trim();

  const rgbMatch = value.match(RGB_FN_RE);
  if (rgbMatch) {
    return {
      r: channelFromPercentOrNumber(rgbMatch[1]),
      g: channelFromPercentOrNumber(rgbMatch[2]),
      b: channelFromPercentOrNumber(rgbMatch[3]),
    };
  }

  const hexMatch = value.match(HEX_RE);
  if (!hexMatch) {
    throw new Error(`hexToRgb: unsupported colour format "${input}"`);
  }
  let hex = hexMatch[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const num = parseInt(hex.slice(0, 6), 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function srgbChannelToLinear(c: number): number {
  const normalized = c / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB colour, in [0, 1]. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbChannelToLinear(rgb.r) +
    0.7152 * srgbChannelToLinear(rgb.g) +
    0.0722 * srgbChannelToLinear(rgb.b)
  );
}

/** WCAG contrast ratio between two colours (any string hexToRgb accepts), in [1, 21]. */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(hexToRgb(a));
  const l2 = relativeLuminance(hexToRgb(b));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA threshold for normal-weight text. */
export const AA_NORMAL_TEXT = 4.5;
