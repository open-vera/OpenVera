import {
  getThemeDefinition,
  isResolvedThemeId,
  THEME_ORDER,
  THEME_REGISTRY,
  type AppThemeId,
  type ResolvedThemeId,
  type ThemeDefinition,
} from "./palettes.js";
import { applyColorTokens, type ThemeColorTokens } from "./tokens.js";
import {
  applyPartnerWallpaper,
  BUILTIN_WALLPAPERS,
  readStoredWallpaperDataUrl,
  resolveWallpaper,
  type WallpaperMode,
} from "./wallpapers.js";

export type { AppThemeId, ResolvedThemeId, ThemeDefinition };

export interface ThemeOption {
  id: Exclude<AppThemeId, "custom">;
  labelZh: string;
  labelEn: string;
  /** bg / surface / border / accent-or-tab color scale */
  preview: [string, string, string, string];
}

export interface ApplyThemeOptions {
  mode?: WallpaperMode;
  customDataUrl?: string | null;
  opacity?: number;
  /** Panel frost blur in px; independent from wallpaper clarity. */
  blur?: number;
  /** When theme is `custom`, apply these extracted tokens instead of a preset. */
  customColors?: ThemeColorTokens | null;
  customScheme?: "light" | "dark";
}

function previewFor(id: Exclude<AppThemeId, "custom">): [string, string, string, string] {
  if (id === "system") {
    const dark = THEME_REGISTRY["github-dark"].colors;
    return [dark.bg, dark.surface, dark.border, dark.tabIndicator];
  }
  const colors = THEME_REGISTRY[id].colors;
  return [
    colors.bg,
    colors.surface,
    colors.border,
    colors.tabIndicator || colors.accent,
  ];
}

export const THEME_OPTIONS: ThemeOption[] = THEME_ORDER.map((id) => {
  if (id === "system") {
    return {
      id,
      labelZh: "跟随系统",
      labelEn: "System",
      preview: previewFor(id),
    };
  }
  const def = THEME_REGISTRY[id];
  return {
    id,
    labelZh: def.labelZh,
    labelEn: def.labelEn,
    preview: previewFor(id),
  };
});

const THEME_IDS = new Set<string>([...THEME_ORDER, "custom"]);

export function isAppThemeId(value: unknown): value is AppThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

/** Migrate legacy `"dark" | "light"` values from older builds. */
export function normalizeThemeId(value: unknown): AppThemeId {
  if (value === "dark") return "github-dark";
  if (value === "light") return "github-light";
  if (isAppThemeId(value)) return value;
  return "system";
}

export function resolveThemeId(
  theme: AppThemeId,
  prefersLight = typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: light)").matches
    : false,
): ResolvedThemeId {
  if (theme === "custom") {
    return prefersLight ? "github-light" : "github-dark";
  }
  if (theme !== "system") return theme;
  return prefersLight ? "github-light" : "github-dark";
}

export function isLightTheme(theme: ResolvedThemeId): boolean {
  return getThemeDefinition(theme).scheme === "light";
}

export function themeDefaultWallpaper(themeId: string) {
  if (!isResolvedThemeId(themeId)) return null;
  const wallpaperId = getThemeDefinition(themeId).wallpaper;
  return wallpaperId ? BUILTIN_WALLPAPERS[wallpaperId] : null;
}

export function applyPartnerTheme(
  theme: AppThemeId,
  wallpaper: ApplyThemeOptions = {},
): ResolvedThemeId {
  const fallback = resolveThemeId(theme === "custom" ? "system" : theme);
  const usingCustom = theme === "custom" && Boolean(wallpaper.customColors);
  const scheme = usingCustom
    ? (wallpaper.customScheme ?? "dark")
    : getThemeDefinition(fallback).scheme;
  const colors = usingCustom
    ? wallpaper.customColors!
    : getThemeDefinition(fallback).colors;

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.theme = usingCustom ? "custom" : fallback;
    root.dataset.colorScheme = scheme;
    root.style.colorScheme = scheme;
    applyColorTokens(colors, root.style);
  }

  const mode = wallpaper.mode ?? "theme";
  const customDataUrl =
    wallpaper.customDataUrl === undefined
      ? readStoredWallpaperDataUrl()
      : wallpaper.customDataUrl;
  applyPartnerWallpaper(
    resolveWallpaper({
      mode,
      customDataUrl,
      opacity: wallpaper.opacity ?? 0.28,
      blur: wallpaper.blur ?? 0,
      themeBuiltin: themeDefaultWallpaper(fallback),
    }),
    scheme,
  );
  return fallback;
}

export function readStoredThemeId(): AppThemeId {
  try {
    const raw = window.localStorage.getItem("partner:ui-settings");
    if (!raw) return "system";
    const parsed = JSON.parse(raw) as { theme?: unknown };
    return normalizeThemeId(parsed.theme);
  } catch {
    return "system";
  }
}
