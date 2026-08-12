import { describe, expect, it } from "vitest";
import {
  clampEditorFontSize,
  EDITOR_PREFERENCE_DEFAULTS,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  normalizeEditorPreferences,
  normalizeEditorTabSize,
} from "@/preview/editor-preferences";

describe("clampEditorFontSize", () => {
  it("keeps values inside the supported range", () => {
    expect(clampEditorFontSize(14)).toBe(14);
  });

  it("clamps to the bounds", () => {
    expect(clampEditorFontSize(2)).toBe(MIN_EDITOR_FONT_SIZE);
    expect(clampEditorFontSize(400)).toBe(MAX_EDITOR_FONT_SIZE);
  });

  it("rounds fractional sizes", () => {
    expect(clampEditorFontSize(13.6)).toBe(14);
  });

  it("falls back for non-finite input", () => {
    expect(clampEditorFontSize(Number.NaN)).toBe(
      EDITOR_PREFERENCE_DEFAULTS.fontSize
    );
  });
});

describe("normalizeEditorTabSize", () => {
  it("accepts the offered sizes", () => {
    expect(normalizeEditorTabSize(4)).toBe(4);
    expect(normalizeEditorTabSize(8)).toBe(8);
  });

  it("snaps an unsupported size back to the default", () => {
    expect(normalizeEditorTabSize(3)).toBe(EDITOR_PREFERENCE_DEFAULTS.tabSize);
    expect(normalizeEditorTabSize(0)).toBe(EDITOR_PREFERENCE_DEFAULTS.tabSize);
    expect(normalizeEditorTabSize(Number.NaN)).toBe(
      EDITOR_PREFERENCE_DEFAULTS.tabSize
    );
  });
});

describe("normalizeEditorPreferences", () => {
  it("returns the defaults for absent or non-object input", () => {
    expect(normalizeEditorPreferences(undefined)).toEqual(
      EDITOR_PREFERENCE_DEFAULTS
    );
    expect(normalizeEditorPreferences(null)).toEqual(
      EDITOR_PREFERENCE_DEFAULTS
    );
    expect(normalizeEditorPreferences("nope")).toEqual(
      EDITOR_PREFERENCE_DEFAULTS
    );
  });

  it("merges a partial payload over the defaults", () => {
    expect(normalizeEditorPreferences({ wordWrap: true })).toEqual({
      ...EDITOR_PREFERENCE_DEFAULTS,
      wordWrap: true,
    });
  });

  it("discards values of the wrong type", () => {
    const prefs = normalizeEditorPreferences({
      fontSize: "big",
      tabSize: null,
      minimap: "yes",
    });

    expect(prefs).toEqual(EDITOR_PREFERENCE_DEFAULTS);
  });

  it("sanitizes out-of-range numbers rather than dropping them", () => {
    const prefs = normalizeEditorPreferences({ fontSize: 999, tabSize: 5 });

    expect(prefs.fontSize).toBe(MAX_EDITOR_FONT_SIZE);
    expect(prefs.tabSize).toBe(EDITOR_PREFERENCE_DEFAULTS.tabSize);
  });

  it("preserves false, which must not be treated as missing", () => {
    const prefs = normalizeEditorPreferences({
      minimap: false,
      lineNumbers: false,
    });

    expect(prefs.minimap).toBe(false);
    expect(prefs.lineNumbers).toBe(false);
  });

  it("does not alias the defaults object", () => {
    const prefs = normalizeEditorPreferences({});
    prefs.fontSize = 20;

    expect(EDITOR_PREFERENCE_DEFAULTS.fontSize).not.toBe(20);
  });
});
