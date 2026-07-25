/**
 * Partner color token system.
 *
 * Themes are data (not CSS blocks). `applyColorTokens` maps this schema onto
 * CSS custom properties consumed by the UI.
 */

export interface ThemeColorTokens {
  bg: string;
  surface: string;
  surfaceElevated: string;
  surfaceInset: string;
  surfaceHover: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  /** UnderlineNav / active tab bar. Defaults to accent when omitted. */
  tabIndicator: string;
  danger: string;
  dangerMuted: string;
  success: string;
  successEmphasis: string;
  attention: string;
  tokenComment: string;
  tokenKeyword: string;
  tokenString: string;
  tokenVariable: string;
  tokenProperty: string;
  tokenNumber: string;
}

export type ThemeColorInput = Omit<
  ThemeColorTokens,
  | "tabIndicator"
  | "tokenComment"
  | "tokenKeyword"
  | "tokenString"
  | "tokenVariable"
  | "tokenProperty"
  | "tokenNumber"
> &
  Partial<
    Pick<
      ThemeColorTokens,
      | "tabIndicator"
      | "tokenComment"
      | "tokenKeyword"
      | "tokenString"
      | "tokenVariable"
      | "tokenProperty"
      | "tokenNumber"
    >
  >;

/** CSS custom property names bound to each token. */
export const THEME_CSS_VARS = {
  bg: "--bg",
  surface: "--surface",
  surfaceElevated: "--surface-elevated",
  surfaceInset: "--surface-inset",
  surfaceHover: "--surface-hover",
  border: "--border",
  text: "--text",
  textMuted: "--text-muted",
  accent: "--accent",
  accentText: "--accent-text",
  tabIndicator: "--tab-indicator",
  danger: "--danger",
  dangerMuted: "--danger-muted",
  success: "--success",
  successEmphasis: "--success-emphasis",
  attention: "--attention",
  tokenComment: "--token-comment",
  tokenKeyword: "--token-keyword",
  tokenString: "--token-string",
  tokenVariable: "--token-variable",
  tokenProperty: "--token-property",
  tokenNumber: "--token-number",
} as const satisfies Record<keyof ThemeColorTokens, `--${string}`>;

export type ThemeCssVar = (typeof THEME_CSS_VARS)[keyof typeof THEME_CSS_VARS];

/** Fill optional tokens so every theme exposes a complete palette. */
export function completeColorTokens(input: ThemeColorInput): ThemeColorTokens {
  return {
    ...input,
    tabIndicator: input.tabIndicator ?? input.accent,
    tokenComment: input.tokenComment ?? input.textMuted,
    tokenKeyword: input.tokenKeyword ?? input.dangerMuted ?? input.danger,
    tokenString: input.tokenString ?? input.success,
    tokenVariable: input.tokenVariable ?? input.attention,
    tokenProperty: input.tokenProperty ?? input.accent,
    tokenNumber: input.tokenNumber ?? input.attention,
  };
}

export function tokensToCssVars(
  tokens: ThemeColorTokens,
): Record<ThemeCssVar, string> {
  const vars = {} as Record<ThemeCssVar, string>;
  for (const key of Object.keys(THEME_CSS_VARS) as Array<keyof ThemeColorTokens>) {
    vars[THEME_CSS_VARS[key]] = tokens[key];
  }
  return vars;
}

/** Solid copies used by wallpaper glass mixing (see app.css). */
const SOLID_TOKEN_VARS: Array<[ThemeCssVar, `--${string}`]> = [
  ["--bg", "--bg-solid"],
  ["--surface", "--surface-solid"],
  ["--surface-elevated", "--surface-elevated-solid"],
  ["--surface-inset", "--surface-inset-solid"],
  ["--surface-hover", "--surface-hover-solid"],
];

export function applyColorTokens(
  tokens: ThemeColorTokens,
  target: CSSStyleDeclaration | null = typeof document !== "undefined"
    ? document.documentElement.style
    : null,
): Record<ThemeCssVar, string> {
  const vars = tokensToCssVars(tokens);
  if (!target) return vars;
  for (const [name, value] of Object.entries(vars)) {
    target.setProperty(name, value);
  }
  for (const [from, solid] of SOLID_TOKEN_VARS) {
    target.setProperty(solid, vars[from]);
  }
  return vars;
}

export function readAppliedColorTokens(
  style: CSSStyleDeclaration | null = typeof document !== "undefined"
    ? getComputedStyle(document.documentElement)
    : null,
): Partial<ThemeColorTokens> {
  if (!style) return {};
  const result: Partial<ThemeColorTokens> = {};
  for (const key of Object.keys(THEME_CSS_VARS) as Array<keyof ThemeColorTokens>) {
    const value = style.getPropertyValue(THEME_CSS_VARS[key]).trim();
    if (value) result[key] = value;
  }
  return result;
}
