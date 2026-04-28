/**
 * Vera terminal UI color theme — palette derived from Claude Code's design system.
 * All RGB values reference claude-code-source/src/utils/theme.ts (dark theme).
 *
 * Use these tokens everywhere instead of inline color literals so the palette
 * stays consistent and can be swapped for a light theme later.
 */

export const theme = {
  // ── Brand ──────────────────────────────────────────────────────────────────
  /** Vera / assistant brand color (Claude orange) */
  brand:            "rgb(215,119,87)",
  brandShimmer:     "rgb(235,159,127)",

  // ── Semantic states ────────────────────────────────────────────────────────
  success:          "rgb(78,186,101)",
  error:            "rgb(255,107,128)",
  warning:          "rgb(255,193,7)",

  // ── Text hierarchy ─────────────────────────────────────────────────────────
  text:             "rgb(255,255,255)",
  textDim:          "rgb(153,153,153)",
  textSubtle:       "rgb(80,80,80)",

  // ── Suggestions / file paths / links ──────────────────────────────────────
  suggestion:       "rgb(177,185,249)",

  // ── Diff ───────────────────────────────────────────────────────────────────
  diffAddedBg:      "rgb(34,92,43)",
  diffAddedWord:    "rgb(56,166,96)",
  diffRemovedBg:    "rgb(122,41,54)",
  diffRemovedWord:  "rgb(179,89,107)",
  diffHunk:         "rgb(100,149,237)",   // cornflower blue for @@ headers

  // ── Message backgrounds ────────────────────────────────────────────────────
  userMsgBg:        "rgb(55,55,55)",

  // ── Status / spinner breathing frames ─────────────────────────────────────
  /** Spinner frames from dark → bright → dark, brand-orange palette */
  spinnerFrames: [
    "rgb(120,60,35)",
    "rgb(150,78,48)",
    "rgb(178,93,60)",
    "rgb(215,119,87)",
    "rgb(235,159,127)",
    "rgb(215,119,87)",
    "rgb(178,93,60)",
    "rgb(150,78,48)",
  ] as string[],

  // ── Plan step status ───────────────────────────────────────────────────────
  stepPending:  "rgb(153,153,153)",
  stepRunning:  "rgb(177,185,249)",
  stepDone:     "rgb(78,186,101)",
  stepFailed:   "rgb(255,107,128)",

  // ── Tool display ───────────────────────────────────────────────────────────
  toolName:     "rgb(215,119,87)",
  toolLabel:    "rgb(153,153,153)",
  toolOk:       "rgb(78,186,101)",
  toolError:    "rgb(255,107,128)",
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
