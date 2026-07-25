export type BuiltinWallpaperId =
  | "book"
  | "inkwash"
  | "worldcup"
  | "ayaka-night"
  | "ayaka-frost";

/** theme = follow active theme; builtin ids pick a fixed asset; custom = uploaded */
export type WallpaperMode = "theme" | "none" | "custom" | BuiltinWallpaperId;

export interface BuiltinWallpaper {
  id: BuiltinWallpaperId;
  labelZh: string;
  labelEn: string;
  /** full CSS background-image value */
  image: string;
  /** Optional raw URL for settings preview thumbnails */
  previewUrl?: string;
  size: string;
  repeat: string;
  blend: string;
  defaultOpacity: number;
}

/**
 * Aged book-page tile: fiber grain + faint ruled fiber streaks + soft stains.
 * Tuned for multiply blend over dim sepia surfaces.
 */
const PAPER_TEXTURE = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360">
  <defs>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="1.15" numOctaves="4" stitchTiles="stitch" seed="11"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.28  0 0 0 0 0.22  0 0 0 0 0.14  0 0 0 0.7 0"/>
    </filter>
    <filter id="fiber" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.015 0.65" numOctaves="2" stitchTiles="stitch" seed="3"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.22  0 0 0 0 0.17  0 0 0 0 0.1  0 0 0 0.45 0"/>
    </filter>
    <radialGradient id="stain1" cx="22%" cy="30%" r="42%">
      <stop offset="0%" stop-color="#5a4630" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#5a4630" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="stain2" cx="78%" cy="68%" r="38%">
      <stop offset="0%" stop-color="#4a3826" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#4a3826" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3a2c1c" stop-opacity="0.16"/>
      <stop offset="8%" stop-color="#3a2c1c" stop-opacity="0"/>
      <stop offset="92%" stop-color="#3a2c1c" stop-opacity="0"/>
      <stop offset="100%" stop-color="#3a2c1c" stop-opacity="0.14"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="#b79f7d"/>
  <rect width="100%" height="100%" filter="url(#grain)" opacity="0.85"/>
  <rect width="100%" height="100%" filter="url(#fiber)" opacity="0.55"/>
  <rect width="100%" height="100%" fill="url(#stain1)"/>
  <rect width="100%" height="100%" fill="url(#stain2)"/>
  <rect width="100%" height="100%" fill="url(#edge)"/>
  <g stroke="#6a563c" stroke-opacity="0.08" stroke-width="1">
    <path d="M0 48 H360 M0 96 H360 M0 144 H360 M0 192 H360 M0 240 H360 M0 288 H360 M0 336 H360"/>
  </g>
</svg>
`.trim());

/** Soft ink-wash blotches on rice paper. */
const INK_TEXTURE = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <defs>
    <filter id="ink" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="7"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.12  0 0 0 0 0.12  0 0 0 0 0.14  0 0 0 0.75 0"/>
      <feGaussianBlur stdDeviation="12"/>
    </filter>
    <radialGradient id="g1" cx="30%" cy="35%" r="45%">
      <stop offset="0%" stop-color="#1a1a1a" stop-opacity="0.55"/>
      <stop offset="70%" stop-color="#1a1a1a" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#1a1a1a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="78%" cy="62%" r="40%">
      <stop offset="0%" stop-color="#2a2a2a" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#2a2a2a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g3" cx="55%" cy="18%" r="28%">
      <stop offset="0%" stop-color="#111" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#111" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="#e9e4da"/>
  <rect width="100%" height="100%" filter="url(#ink)" opacity="0.35"/>
  <ellipse cx="190" cy="170" rx="180" ry="140" fill="url(#g1)"/>
  <ellipse cx="500" cy="300" rx="160" ry="130" fill="url(#g2)"/>
  <ellipse cx="360" cy="90" rx="110" ry="80" fill="url(#g3)"/>
</svg>
`.trim());

export const BUILTIN_WALLPAPERS: Record<BuiltinWallpaperId, BuiltinWallpaper> = {
  book: {
    id: "book",
    labelZh: "书卷纸纹",
    labelEn: "Parchment",
    image: `url("data:image/svg+xml,${PAPER_TEXTURE}")`,
    size: "420px 420px",
    repeat: "repeat",
    blend: "multiply",
    defaultOpacity: 0.52,
  },
  inkwash: {
    id: "inkwash",
    labelZh: "水墨晕染",
    labelEn: "Ink Wash",
    image: `url("data:image/svg+xml,${INK_TEXTURE}")`,
    size: "cover",
    repeat: "no-repeat",
    blend: "multiply",
    defaultOpacity: 0.42,
  },
  worldcup: {
    id: "worldcup",
    labelZh: "世界杯赛场",
    labelEn: "World Cup Pitch",
    image: 'url("/wallpapers/worldcup.png")',
    previewUrl: "/wallpapers/worldcup.png",
    size: "cover",
    repeat: "no-repeat",
    blend: "normal",
    defaultOpacity: 0.24,
  },
  "ayaka-night": {
    id: "ayaka-night",
    labelZh: "夜樱",
    labelEn: "Night Bloom",
    image: 'url("/wallpapers/ayaka-night.png")',
    previewUrl: "/wallpapers/ayaka-night.png",
    size: "cover",
    repeat: "no-repeat",
    blend: "normal",
    defaultOpacity: 0.32,
  },
  "ayaka-frost": {
    id: "ayaka-frost",
    labelZh: "霜华",
    labelEn: "Frost Bloom",
    image: 'url("/wallpapers/ayaka-frost.png")',
    previewUrl: "/wallpapers/ayaka-frost.png",
    size: "cover",
    repeat: "no-repeat",
    blend: "normal",
    defaultOpacity: 0.28,
  },
};

export const BUILTIN_WALLPAPER_ORDER: BuiltinWallpaperId[] = [
  "ayaka-night",
  "ayaka-frost",
  "book",
  "inkwash",
  "worldcup",
];

export const DEFAULT_WALLPAPER_OPACITY = 0.28;
export const MIN_WALLPAPER_OPACITY = 0.05;
export const MAX_WALLPAPER_OPACITY = 1;
/** Panel frost blur in px. Independent from clarity/opacity. */
export const DEFAULT_WALLPAPER_BLUR = 0;
export const MIN_WALLPAPER_BLUR = 0;
export const MAX_WALLPAPER_BLUR = 40;
export const WALLPAPER_STORAGE_KEY = "partner:wallpaper-image";
/** Keep under typical 5MB localStorage quotas while favoring sharpness. */
const MAX_WALLPAPER_BYTES = 2_800_000;
const MAX_WALLPAPER_EDGE = 2880;

export function clampWallpaperOpacity(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_WALLPAPER_OPACITY;
  return Math.min(MAX_WALLPAPER_OPACITY, Math.max(MIN_WALLPAPER_OPACITY, num));
}

export function clampWallpaperBlur(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_WALLPAPER_BLUR;
  return Math.min(MAX_WALLPAPER_BLUR, Math.max(MIN_WALLPAPER_BLUR, num));
}

export function isBuiltinWallpaperId(value: unknown): value is BuiltinWallpaperId {
  return typeof value === "string" && value in BUILTIN_WALLPAPERS;
}

export function isWallpaperMode(value: unknown): value is WallpaperMode {
  return (
    value === "theme" ||
    value === "none" ||
    value === "custom" ||
    isBuiltinWallpaperId(value)
  );
}

export function getBuiltinWallpaper(id: BuiltinWallpaperId): BuiltinWallpaper {
  return BUILTIN_WALLPAPERS[id];
}

export interface ResolvedWallpaper {
  image: string | null;
  size: string;
  repeat: string;
  blend: string;
  opacity: number;
  /** Frosted-glass blur on chrome panels, in CSS px. */
  blur: number;
}

/** Raw image URL/data-URL suitable for <img> / canvas palette extraction. */
export function resolveWallpaperImageUrl(params: {
  mode: WallpaperMode;
  customDataUrl: string | null;
  themeBuiltin?: BuiltinWallpaper | null;
}): string | null {
  if (params.mode === "none") return null;
  if (params.mode === "custom") {
    return params.customDataUrl?.startsWith("data:image/") ? params.customDataUrl : null;
  }
  const builtin = isBuiltinWallpaperId(params.mode)
    ? BUILTIN_WALLPAPERS[params.mode]
    : params.mode === "theme"
      ? params.themeBuiltin
      : null;
  if (!builtin) return null;
  if (builtin.previewUrl) return builtin.previewUrl;
  const matched = /^url\(["']?(.*?)["']?\)$/.exec(builtin.image);
  return matched?.[1] ?? null;
}

export function resolveWallpaper(params: {
  mode: WallpaperMode;
  customDataUrl: string | null;
  opacity: number;
  blur?: number;
  /** Theme-attached builtin wallpaper, when wallpaperMode=theme */
  themeBuiltin?: BuiltinWallpaper | null;
}): ResolvedWallpaper {
  const opacity = clampWallpaperOpacity(params.opacity);
  const blur = clampWallpaperBlur(params.blur ?? DEFAULT_WALLPAPER_BLUR);
  if (params.mode === "none") {
    return {
      image: null,
      size: "cover",
      repeat: "no-repeat",
      blend: "soft-light",
      opacity: 0,
      blur: 0,
    };
  }
  if (params.mode === "custom" && params.customDataUrl) {
    return {
      image: `url("${params.customDataUrl}")`,
      size: "cover",
      repeat: "no-repeat",
      blend: "normal",
      opacity,
      blur,
    };
  }
  const selected =
    params.mode === "theme"
      ? params.themeBuiltin
      : isBuiltinWallpaperId(params.mode)
        ? BUILTIN_WALLPAPERS[params.mode]
        : null;
  if (selected) {
    return {
      image: selected.image,
      size: selected.size,
      repeat: selected.repeat,
      blend: selected.blend,
      opacity,
      blur,
    };
  }
  return {
    image: null,
    size: "cover",
    repeat: "no-repeat",
    blend: "soft-light",
    opacity: 0,
    blur: 0,
  };
}

const GLASS_SURFACE_VARS: Array<{
  cssVar: string;
  solid: string;
  boost?: number;
}> = [
  { cssVar: "--bg", solid: "--bg-solid" },
  { cssVar: "--surface", solid: "--surface-solid", boost: 6 },
  { cssVar: "--surface-elevated", solid: "--surface-elevated-solid", boost: 10 },
  { cssVar: "--surface-inset", solid: "--surface-inset-solid" },
  { cssVar: "--surface-hover", solid: "--surface-hover-solid", boost: 4 },
];

/** Light UI over busy wallpapers needs denser glass + panel frost. */
export const LIGHT_SCHEME_MIN_CHROME_FILL = 84;
export const LIGHT_SCHEME_MIN_PANEL_FROST = 14;

/**
 * Higher clarity → more translucent chrome over the wallpaper.
 * Light schemes keep a higher minimum fill so pale tokens stay readable
 * over dark wallpapers (otherwise thin white glass still looks muddy).
 */
export function chromeFillPercent(
  opacity: number,
  scheme: "light" | "dark" = "dark",
): number {
  const curve = Math.round((1 - opacity * 0.92) * 100);
  return Math.max(scheme === "light" ? LIGHT_SCHEME_MIN_CHROME_FILL : 8, curve);
}

/** Panel backdrop frost; light schemes always keep a readability floor. */
export function panelFrostPx(
  blur: number,
  scheme: "light" | "dark" = "dark",
): number {
  const clamped = clampWallpaperBlur(blur);
  return scheme === "light"
    ? Math.max(clamped, LIGHT_SCHEME_MIN_PANEL_FROST)
    : clamped;
}

function applyGlassChrome(
  opacity: number,
  scheme: "light" | "dark" = "dark",
): void {
  const root = document.documentElement.style;
  const fill = chromeFillPercent(opacity, scheme);
  root.setProperty("--chrome-fill", `${fill}%`);
  for (const { cssVar, solid, boost = 0 } of GLASS_SURFACE_VARS) {
    const amount = Math.min(100, fill + boost);
    root.setProperty(cssVar, `color-mix(in srgb, var(${solid}) ${amount}%, transparent)`);
  }
}

function restoreSolidChrome(): void {
  const root = document.documentElement.style;
  for (const { cssVar, solid } of GLASS_SURFACE_VARS) {
    const solidValue =
      typeof root.getPropertyValue === "function"
        ? root.getPropertyValue(solid).trim()
        : "";
    if (solidValue) root.setProperty(cssVar, solidValue);
  }
}

export function applyPartnerWallpaper(
  wallpaper: ResolvedWallpaper,
  scheme: "light" | "dark" = "dark",
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (wallpaper.image) {
    const blur = clampWallpaperBlur(wallpaper.blur);
    const frost = panelFrostPx(blur, scheme);
    root.dataset.wallpaper = "on";
    // Wallpaper-layer blur follows the slider; panel frost may be higher in light mode.
    root.dataset.wallpaperBlur = blur > 0 ? "on" : "off";
    root.dataset.panelFrost = frost > 0 ? "on" : "off";
    root.style.setProperty("--wallpaper-image", wallpaper.image);
    root.style.setProperty("--wallpaper-size", wallpaper.size);
    root.style.setProperty("--wallpaper-repeat", wallpaper.repeat);
    root.style.setProperty("--wallpaper-blend", wallpaper.blend);
    // Wallpaper itself stays full-strength; clarity only controls panel glass.
    root.style.setProperty("--wallpaper-opacity", "1");
    root.style.setProperty("--wallpaper-blur", `${blur}px`);
    root.style.setProperty("--panel-frost", `${frost}px`);
    applyGlassChrome(wallpaper.opacity, scheme);
  } else {
    root.dataset.wallpaper = "off";
    root.dataset.wallpaperBlur = "off";
    root.dataset.panelFrost = "off";
    root.style.setProperty("--wallpaper-image", "none");
    root.style.setProperty("--wallpaper-opacity", "0");
    root.style.setProperty("--wallpaper-blur", "0px");
    root.style.setProperty("--panel-frost", "0px");
    restoreSolidChrome();
  }
}

export function readStoredWallpaperDataUrl(): string | null {
  try {
    const value = window.localStorage.getItem(WALLPAPER_STORAGE_KEY);
    return value && value.startsWith("data:image/") ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredWallpaperDataUrl(dataUrl: string | null): void {
  try {
    if (!dataUrl) {
      window.localStorage.removeItem(WALLPAPER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(WALLPAPER_STORAGE_KEY, dataUrl);
  } catch (error) {
    console.warn("[Theme] failed to persist wallpaper image:", error);
    throw error;
  }
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Invalid image file"));
    image.src = dataUrl;
  });
}

/** Compress/resize a picked image into a localStorage-friendly data URL. */
export async function prepareWallpaperDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file");
  }
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Failed to read image"));
    };
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });

  const image = await loadImageElement(original);
  const scale = Math.min(1, MAX_WALLPAPER_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  // Already small enough and under quota — keep the original bytes (no re-encode soft).
  if (scale === 1 && original.length <= MAX_WALLPAPER_BYTES) {
    return original;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);

  const preferPng = file.type === "image/png" || file.type === "image/webp";
  if (preferPng) {
    const pngUrl = canvas.toDataURL("image/png");
    if (pngUrl.length <= MAX_WALLPAPER_BYTES) return pngUrl;
  }

  let quality = 0.92;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > MAX_WALLPAPER_BYTES && quality > 0.55) {
    quality -= 0.05;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > MAX_WALLPAPER_BYTES) {
    throw new Error("Image is too large after compression");
  }
  return dataUrl;
}
