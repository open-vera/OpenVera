/**
 * Extract a few distinct UI palettes from a wallpaper image.
 * Variants are rule-based (dark / light / vivid / soft) so they stay readable
 * and visually different, not a single average color wash.
 */

import { completeColorTokens, type ThemeColorTokens } from "./tokens.js";

export type CustomPaletteId = "dark" | "light" | "vivid" | "soft";

export interface CustomPaletteVariant {
  id: CustomPaletteId;
  labelZh: string;
  labelEn: string;
  scheme: "light" | "dark";
  colors: ThemeColorTokens;
  preview: [string, string, string, string];
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const VARIANT_META: Record<
  CustomPaletteId,
  { labelZh: string; labelEn: string; scheme: "light" | "dark" }
> = {
  dark: { labelZh: "深邃", labelEn: "Deep", scheme: "dark" },
  light: { labelZh: "清透", labelEn: "Airy", scheme: "light" },
  vivid: { labelZh: "浓郁", labelEn: "Vivid", scheme: "dark" },
  soft: { labelZh: "柔和", labelEn: "Soft", scheme: "light" },
};

export const CUSTOM_PALETTE_ORDER: CustomPaletteId[] = [
  "dark",
  "light",
  "vivid",
  "soft",
];

export function isCustomPaletteId(value: unknown): value is CustomPaletteId {
  return (
    value === "dark" || value === "light" || value === "vivid" || value === "soft"
  );
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((c) => clampByte(c).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function shade(rgb: Rgb, amount: number): Rgb {
  return mix(rgb, { r: 0, g: 0, b: 0 }, amount);
}

function tint(rgb: Rgb, amount: number): Rgb {
  return mix(rgb, { r: 255, g: 255, b: 255 }, amount);
}

function desaturate(rgb: Rgb, amount: number): Rgb {
  const gray = relativeLuminance(rgb) * 255;
  return mix(rgb, { r: gray, g: gray, b: gray }, amount);
}

function contrastText(bg: Rgb): Rgb {
  return relativeLuminance(bg) > 0.45
    ? { r: 32, g: 36, b: 48 }
    : { r: 240, g: 242, b: 248 };
}

function readableOn(bg: Rgb, preferred: Rgb): Rgb {
  const text = contrastText(bg);
  // Keep preferred hue if contrast against bg is acceptable via luminance gap.
  const gap = Math.abs(relativeLuminance(preferred) - relativeLuminance(bg));
  return gap >= 0.28 ? preferred : text;
}

/** Bucket pixels into a coarse RGB histogram and return weighted centers. */
export function sampleDominantColors(pixels: Rgb[], maxColors = 8): Rgb[] {
  if (pixels.length === 0) {
    return [
      { r: 24, g: 24, b: 28 },
      { r: 180, g: 100, b: 110 },
      { r: 176, g: 196, b: 222 },
    ];
  }

  type Bucket = { r: number; g: number; b: number; n: number };
  const buckets = new Map<string, Bucket>();

  for (const p of pixels) {
    // Skip near-transparent-looking near-black noise sparingly; keep dark scene colors.
    const key = `${p.r >> 4},${p.g >> 4},${p.b >> 4}`;
    const cur = buckets.get(key);
    if (cur) {
      cur.r += p.r;
      cur.g += p.g;
      cur.b += p.b;
      cur.n += 1;
    } else {
      buckets.set(key, { r: p.r, g: p.g, b: p.b, n: 1 });
    }
  }

  const ranked = [...buckets.values()]
    .map((b) => ({
      r: b.r / b.n,
      g: b.g / b.n,
      b: b.b / b.n,
      n: b.n,
      sat: saturation({ r: b.r / b.n, g: b.g / b.n, b: b.b / b.n }),
    }))
    .sort((a, b) => b.n * (0.55 + a.sat * 0.45) - a.n * (0.55 + b.sat * 0.45));

  const picked: Rgb[] = [];
  for (const c of ranked) {
    const rgb = { r: c.r, g: c.g, b: c.b };
    const tooClose = picked.some((p) => colorDistance(p, rgb) < 42);
    if (!tooClose) picked.push(rgb);
    if (picked.length >= maxColors) break;
  }

  while (picked.length < 3) {
    picked.push(picked[picked.length - 1] ?? { r: 80, g: 80, b: 90 });
  }
  return picked;
}

function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function pickAccent(colors: Rgb[]): Rgb {
  return [...colors].sort(
    (a, b) =>
      saturation(b) * 0.7 + relativeLuminance(b) * 0.15 -
      (saturation(a) * 0.7 + relativeLuminance(a) * 0.15),
  )[0];
}

function pickDarkest(colors: Rgb[]): Rgb {
  return [...colors].sort((a, b) => relativeLuminance(a) - relativeLuminance(b))[0];
}

function pickLightest(colors: Rgb[]): Rgb {
  return [...colors].sort((a, b) => relativeLuminance(b) - relativeLuminance(a))[0];
}

function buildTokens(params: {
  bg: Rgb;
  surface: Rgb;
  border: Rgb;
  accent: Rgb;
  tab: Rgb;
  scheme: "light" | "dark";
}): ThemeColorTokens {
  const text = contrastText(params.bg);
  const muted = mix(text, params.bg, 0.42);
  const hover = params.scheme === "dark" ? tint(params.surface, 0.08) : shade(params.surface, 0.06);
  const inset = params.scheme === "dark" ? shade(params.bg, 0.35) : shade(params.bg, 0.08);
  const elevated =
    params.scheme === "dark" ? tint(params.surface, 0.04) : tint(params.surface, 0.02);
  const accentText = contrastText(params.accent);

  return completeColorTokens({
    bg: rgbToHex(params.bg),
    surface: rgbToHex(params.surface),
    surfaceElevated: rgbToHex(elevated),
    surfaceInset: rgbToHex(inset),
    surfaceHover: rgbToHex(hover),
    border: rgbToHex(params.border),
    text: rgbToHex(text),
    textMuted: rgbToHex(muted),
    accent: rgbToHex(params.accent),
    accentText: rgbToHex(accentText),
    tabIndicator: rgbToHex(params.tab),
    danger: rgbToHex(mix(params.accent, { r: 200, g: 60, b: 70 }, 0.55)),
    dangerMuted: rgbToHex(tint(mix(params.accent, { r: 200, g: 60, b: 70 }, 0.4), 0.15)),
    success: rgbToHex(desaturate(mix(params.accent, { r: 70, g: 160, b: 110 }, 0.7), 0.15)),
    successEmphasis: rgbToHex(shade(mix(params.accent, { r: 70, g: 160, b: 110 }, 0.7), 0.2)),
    attention: rgbToHex(mix(params.tab, { r: 210, g: 170, b: 80 }, 0.45)),
    tokenKeyword: rgbToHex(readableOn(params.bg, params.accent)),
    tokenString: rgbToHex(
      readableOn(params.bg, desaturate(mix(params.accent, { r: 120, g: 180, b: 220 }, 0.5), 0.1)),
    ),
    tokenVariable: rgbToHex(readableOn(params.bg, params.tab)),
    tokenProperty: rgbToHex(readableOn(params.bg, tint(params.accent, 0.25))),
    tokenNumber: rgbToHex(readableOn(params.bg, mix(params.tab, { r: 220, g: 180, b: 100 }, 0.4))),
    tokenComment: rgbToHex(muted),
  });
}

export function buildPaletteVariants(dominant: Rgb[]): CustomPaletteVariant[] {
  const accent = pickAccent(dominant);
  const darkBase = shade(pickDarkest(dominant), 0.35);
  const lightBase = tint(pickLightest(dominant), 0.55);
  const mid = dominant[Math.floor(dominant.length / 2)] ?? accent;

  const recipes: Record<CustomPaletteId, Parameters<typeof buildTokens>[0]> = {
    dark: {
      scheme: "dark",
      bg: shade(darkBase, 0.15),
      surface: tint(darkBase, 0.1),
      border: tint(darkBase, 0.28),
      accent: desaturate(accent, 0.08),
      tab: mix(accent, { r: 201, g: 164, b: 92 }, 0.35),
    },
    light: {
      scheme: "light",
      // Keep a hint of wallpaper hue so "airy" isn't a sterile white card.
      bg: tint(mix(lightBase, { r: 252, g: 248, b: 246 }, 0.55), 0.12),
      surface: tint(mix(lightBase, { r: 255, g: 253, b: 252 }, 0.72), 0.08),
      border: desaturate(mix(lightBase, accent, 0.22), 0.3),
      accent: mix(accent, { r: 224, g: 145, b: 163 }, 0.25),
      tab: mix(mid, { r: 126, g: 176, b: 212 }, 0.45),
    },
    vivid: {
      scheme: "dark",
      bg: mix(shade(darkBase, 0.1), accent, 0.08),
      surface: mix(tint(darkBase, 0.12), accent, 0.12),
      border: mix(tint(darkBase, 0.3), accent, 0.25),
      accent: tint(accent, 0.05),
      tab: mix(accent, pickLightest(dominant), 0.25),
    },
    soft: {
      scheme: "light",
      bg: desaturate(tint(mix(lightBase, accent, 0.12), 0.35), 0.2),
      surface: tint(desaturate(lightBase, 0.25), 0.4),
      border: desaturate(mix(lightBase, accent, 0.18), 0.4),
      accent: desaturate(accent, 0.25),
      tab: desaturate(mix(mid, accent, 0.3), 0.2),
    },
  };

  return CUSTOM_PALETTE_ORDER.map((id) => {
    const colors = buildTokens(recipes[id]);
    return {
      id,
      ...VARIANT_META[id],
      colors,
      preview: [colors.bg, colors.surface, colors.border, colors.tabIndicator],
    };
  });
}

/** Sample ImageData / raw RGBA buffer into RGB list (skips mostly-transparent). */
export function pixelsFromRgba(
  data: ArrayLike<number>,
  step = 4,
): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < data.length; i += 4 * step) {
    const a = data[i + 3] ?? 255;
    if (a < 40) continue;
    out.push({ r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0 });
  }
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load wallpaper for palette extraction"));
    // data: and same-origin /wallpapers/* are fine without crossOrigin
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.src = src;
  });
}

export async function extractPixelsFromImageUrl(imageUrl: string): Promise<Rgb[]> {
  if (typeof document === "undefined") return [];
  const img = await loadImage(imageUrl);
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  return pixelsFromRgba(data, 2);
}

export async function extractCustomPalettes(
  imageUrl: string,
): Promise<CustomPaletteVariant[]> {
  const pixels = await extractPixelsFromImageUrl(imageUrl);
  return buildPaletteVariants(sampleDominantColors(pixels));
}

export function customPalettePreview(
  variant: CustomPaletteVariant,
): [string, string, string, string] {
  return variant.preview;
}
