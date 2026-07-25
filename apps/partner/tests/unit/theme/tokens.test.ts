import { describe, expect, it } from "vitest";
import {
  THEME_CSS_VARS,
  THEME_REGISTRY,
  applyColorTokens,
  completeColorTokens,
  getThemeDefinition,
  tokensToCssVars,
} from "@/theme";

describe("partner color token system", () => {
  it("completes optional tokens from core palette", () => {
    const tokens = completeColorTokens({
      bg: "#111",
      surface: "#222",
      surfaceElevated: "#333",
      surfaceInset: "#000",
      surfaceHover: "#444",
      border: "#555",
      text: "#eee",
      textMuted: "#999",
      accent: "#0af",
      accentText: "#000",
      danger: "#f00",
      dangerMuted: "#f66",
      success: "#0f0",
      successEmphasis: "#090",
      attention: "#ff0",
    });

    expect(tokens.tabIndicator).toBe("#0af");
    expect(tokens.tokenComment).toBe("#999");
    expect(tokens.tokenKeyword).toBe("#f66");
    expect(tokens.tokenProperty).toBe("#0af");
  });

  it("maps every token to a CSS custom property", () => {
    const def = getThemeDefinition("github-dark");
    const vars = tokensToCssVars(def.colors);
    expect(vars["--bg"]).toBe("#0d1117");
    expect(vars["--tab-indicator"]).toBe("#f78166");
    expect(vars["--accent"]).toBe("#58a6ff");
    expect(Object.keys(vars).sort()).toEqual(Object.values(THEME_CSS_VARS).sort());
  });

  it("applies tokens onto a style target", () => {
    const props: Record<string, string> = {};
    const style = {
      setProperty(name: string, value: string) {
        props[name] = value;
      },
    } as CSSStyleDeclaration;

    applyColorTokens(THEME_REGISTRY.cursor.colors, style);
    expect(props["--bg"]).toBe("#181818");
    expect(props["--bg-solid"]).toBe("#181818");
    expect(props["--surface-solid"]).toBe(THEME_REGISTRY.cursor.colors.surface);
    expect(props["--accent"]).toBe("#81c7bb");
    expect(props["--tab-indicator"]).toBe("#81c7bb");
  });

  it("keeps registry themes self-describing for the picker", () => {
    expect(THEME_REGISTRY["github-dark"].scheme).toBe("dark");
    expect(THEME_REGISTRY.book.wallpaper).toBe("book");
    expect(THEME_REGISTRY.worldcup.colors.accent).toBe("#e53935");
    expect(THEME_REGISTRY.worldcup.colors.tabIndicator).toBe("#f2c94c");
  });
});
