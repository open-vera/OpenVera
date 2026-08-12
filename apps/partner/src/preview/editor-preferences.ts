/** Editor preferences surfaced in Settings › 编辑器 and applied to CodeEditor. */
export interface EditorPreferences {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
}

export const EDITOR_PREFERENCE_DEFAULTS: EditorPreferences = {
  fontSize: 13,
  tabSize: 2,
  wordWrap: false,
  minimap: true,
  lineNumbers: true,
};

export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 24;
export const EDITOR_TAB_SIZES = [2, 4, 8] as const;

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_PREFERENCE_DEFAULTS.fontSize;
  return Math.min(
    MAX_EDITOR_FONT_SIZE,
    Math.max(MIN_EDITOR_FONT_SIZE, Math.round(value))
  );
}

export function normalizeEditorTabSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_PREFERENCE_DEFAULTS.tabSize;
  const rounded = Math.round(value);
  // Snap to the offered choices so a hand-edited store cannot produce tab 3.
  return EDITOR_TAB_SIZES.includes(rounded as (typeof EDITOR_TAB_SIZES)[number])
    ? rounded
    : EDITOR_PREFERENCE_DEFAULTS.tabSize;
}

/** Merge persisted values over the defaults, discarding anything invalid. */
export function normalizeEditorPreferences(value: unknown): EditorPreferences {
  if (!value || typeof value !== "object")
    return { ...EDITOR_PREFERENCE_DEFAULTS };
  const raw = value as Partial<Record<keyof EditorPreferences, unknown>>;
  return {
    fontSize:
      typeof raw.fontSize === "number"
        ? clampEditorFontSize(raw.fontSize)
        : EDITOR_PREFERENCE_DEFAULTS.fontSize,
    tabSize:
      typeof raw.tabSize === "number"
        ? normalizeEditorTabSize(raw.tabSize)
        : EDITOR_PREFERENCE_DEFAULTS.tabSize,
    wordWrap:
      typeof raw.wordWrap === "boolean"
        ? raw.wordWrap
        : EDITOR_PREFERENCE_DEFAULTS.wordWrap,
    minimap:
      typeof raw.minimap === "boolean"
        ? raw.minimap
        : EDITOR_PREFERENCE_DEFAULTS.minimap,
    lineNumbers:
      typeof raw.lineNumbers === "boolean"
        ? raw.lineNumbers
        : EDITOR_PREFERENCE_DEFAULTS.lineNumbers,
  };
}
