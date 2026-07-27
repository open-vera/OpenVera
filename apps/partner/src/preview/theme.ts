import { syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";

export const partnerEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    position: "relative",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    padding: "12px 16px 12px 0",
    // Narrow side panels keep a readable code column and scroll horizontally.
    minWidth: "max(100%, 48rem)",
    whiteSpace: "pre",
  },
  ".cm-line": {
    whiteSpace: "pre",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: "1.6",
    backgroundColor: "var(--bg)",
    position: "relative",
    overflowX: "auto",
    overflowY: "auto",
    scrollbarWidth: "thin",
    scrollbarColor: "color-mix(in srgb, var(--text-muted) 36%, transparent) transparent",
  },
  ".cm-scroller::-webkit-scrollbar": {
    width: "6px",
    height: "6px",
  },
  ".cm-scroller::-webkit-scrollbar-track": {
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    borderRadius: "999px",
    background: "color-mix(in srgb, var(--text-muted) 30%, transparent)",
  },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": {
    background: "color-mix(in srgb, var(--text-muted) 48%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "color-mix(in srgb, var(--text-muted) 82%, transparent)",
    borderRight: "none",
    paddingLeft: "8px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
    color: "var(--text)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--accent)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 12px 0 4px",
  },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 4px",
  },
  ".cm-foldGutter .cm-gutterElement span": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    color: "var(--text-muted)",
    fontSize: "0",
    verticalAlign: "middle",
  },
  ".cm-foldGutter .cm-gutterElement span::before": {
    content: '""',
    width: "7px",
    height: "7px",
    borderRight: "2px solid currentColor",
    borderBottom: "2px solid currentColor",
    transform: "rotate(-45deg)",
    transition: "transform 120ms ease",
  },
  '.cm-foldGutter .cm-gutterElement span[title="Fold line"]::before': {
    transform: "rotate(45deg)",
  },
  '.cm-foldGutter .cm-gutterElement span[title="Unfold line"]::before': {
    transform: "rotate(-45deg)",
  },
  ".cm-foldGutter .cm-gutterElement span:hover": {
    color: "var(--text)",
  },
  // Folded-range chip (`{ … }`) — follow theme tokens instead of CM default white pill.
  ".cm-foldPlaceholder": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 3px",
    border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
    borderRadius: "5px",
    padding: "0 7px",
    background: "color-mix(in srgb, var(--surface-elevated) 78%, var(--bg))",
    color: "var(--text-muted)",
    fontFamily: "inherit",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0.12em",
    lineHeight: "1.35",
    verticalAlign: "middle",
    cursor: "pointer",
    boxShadow: "none",
  },
  ".cm-foldPlaceholder:hover": {
    borderColor: "color-mix(in srgb, var(--accent) 42%, var(--border))",
    background: "color-mix(in srgb, var(--accent) 12%, var(--surface-elevated))",
    color: "var(--text)",
  },
  ".partner-floating-minimap.cm-minimap-gutter": {
    position: "absolute !important",
    top: "18px",
    right: "10px",
    bottom: "auto",
    zIndex: "8",
    width: "34px !important",
    maxWidth: "34px !important",
    minWidth: "34px !important",
    height: "fit-content !important",
    minHeight: "120px",
    maxHeight: "min(72%, 520px)",
    overflow: "hidden !important",
    display: "inline-block",
    contain: "layout paint",
    border: "1px solid color-mix(in srgb, var(--border) 42%, transparent)",
    borderRadius: "9px",
    background:
      "linear-gradient(180deg, color-mix(in srgb, #21262d 46%, transparent), color-mix(in srgb, #010409 52%, transparent))",
    boxShadow: "0 12px 34px rgba(0, 0, 0, 0.24)",
    opacity: "0.46",
    backdropFilter: "blur(10px)",
    pointerEvents: "auto",
    transform: "translateZ(0)",
    transition:
      "opacity 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease",
  },
  ".partner-floating-minimap.cm-minimap-gutter:hover": {
    opacity: "0.9",
    borderColor: "color-mix(in srgb, var(--accent) 30%, var(--border))",
    boxShadow: "0 16px 42px rgba(0, 0, 0, 0.34)",
    transform: "translateX(-2px)",
  },
  ".partner-floating-minimap .cm-minimap-inner": {
    height: "fit-content !important",
    minHeight: "120px !important",
    width: "34px !important",
    maxHeight: "inherit",
    borderRadius: "inherit",
    overflow: "hidden !important",
    scrollbarWidth: "none",
  },
  ".partner-floating-minimap .cm-minimap-inner::-webkit-scrollbar": {
    display: "none",
  },
  ".partner-floating-minimap canvas": {
    width: "34px !important",
    maxWidth: "34px !important",
    height: "auto !important",
    minHeight: "120px",
    maxHeight: "inherit",
    opacity: "0.66",
  },
  ".partner-floating-minimap .cm-minimap-overlay-container": {
    inset: "0",
  },
  ".partner-floating-minimap .cm-minimap-overlay": {
    left: "2px",
    right: "2px",
    borderRadius: "5px",
    background: "color-mix(in srgb, var(--accent) 13%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
  },
  ".cm-diagnostic-error": {
    borderBottom: "2px wavy #f85149",
  },
  ".cm-diagnostic-warning": {
    borderBottom: "2px wavy #d29922",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-elevated)",
    border: "1px solid var(--border)",
    color: "var(--text)",
  },
  ".cm-panels": {
    background: "transparent",
    border: "none",
    color: "var(--text)",
  },
  ".cm-panels-top": {
    position: "absolute",
    top: "10px",
    right: "14px",
    left: "auto",
    zIndex: "20",
  },
  ".cm-panel.cm-search": {
    display: "grid",
    gridTemplateColumns: "20px minmax(220px, 360px) repeat(3, 24px) 10px repeat(2, 24px) 24px",
    columnGap: "4px",
    rowGap: "4px",
    alignItems: "center",
    width: "auto",
    padding: "5px 7px",
    border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
    borderRadius: "7px",
    background: "color-mix(in srgb, var(--surface-elevated) 96%, black)",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
    color: "var(--text)",
  },
  ".cm-panel.cm-search input.cm-textfield": {
    height: "24px",
    minWidth: "0",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    padding: "0 7px",
    background: "var(--bg)",
    color: "var(--text)",
    font: "inherit",
    fontSize: "12px",
  },
  ".cm-panel.cm-search .partner-search-toggle": {
    gridColumn: "1",
    gridRow: "1",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "24px",
    minWidth: "20px",
    border: "none",
    borderRadius: "4px",
    padding: "0",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  ".cm-panel.cm-search .partner-search-toggle:hover": {
    background: "var(--surface-hover)",
    color: "var(--text)",
  },
  ".cm-panel.cm-search .partner-search-toggle svg": {
    width: "14px",
    height: "14px",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    transform: "rotate(-90deg)",
    transition: "transform 120ms ease",
  },
  ".cm-panel.cm-search.partner-search-replace-open .partner-search-toggle svg": {
    transform: "rotate(0deg)",
  },
  ".cm-panel.cm-search input.cm-textfield:focus": {
    borderColor: "color-mix(in srgb, var(--accent) 75%, var(--border))",
    outline: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
  },
  ".cm-panel.cm-search input[name='search']": {
    gridColumn: "2",
    gridRow: "1",
  },
  ".cm-panel.cm-search input[name='replace']": {
    display: "none",
    gridColumn: "2 / 6",
    gridRow: "2",
  },
  ".cm-panel.cm-search.partner-search-replace-open input[name='replace']": {
    display: "block",
  },
  ".cm-panel.cm-search br": {
    display: "none",
  },
  ".cm-panel.cm-search button": {
    position: "relative",
    width: "24px",
    height: "24px",
    minWidth: "24px",
    border: "none",
    borderRadius: "4px",
    padding: "0",
    background: "transparent",
    color: "var(--text)",
    font: "inherit",
    fontSize: "0",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button:hover": {
    background: "var(--surface-hover)",
  },
  ".cm-panel.cm-search button::before": {
    fontSize: "16px",
    lineHeight: "1",
  },
  ".cm-panel.cm-search button[name='next']": {
    gridColumn: "8",
    gridRow: "1",
  },
  ".cm-panel.cm-search button[name='next']::before": {
    content: '"↓"',
  },
  ".cm-panel.cm-search button[name='prev']": {
    gridColumn: "7",
    gridRow: "1",
  },
  ".cm-panel.cm-search button[name='prev']::before": {
    content: '"↑"',
  },
  ".cm-panel.cm-search button[name='select']": {
    display: "none",
  },
  ".cm-panel.cm-search button[name='replace'], .cm-panel.cm-search button[name='replaceAll']": {
    display: "none",
  },
  ".cm-panel.cm-search.partner-search-replace-open button[name='replace'], .cm-panel.cm-search.partner-search-replace-open button[name='replaceAll']": {
    display: "block",
    gridRow: "2",
  },
  ".cm-panel.cm-search button[name='replace']": {
    gridColumn: "7",
  },
  ".cm-panel.cm-search button[name='replace']::before": {
    content: '"↵"',
  },
  ".cm-panel.cm-search button[name='replaceAll']": {
    gridColumn: "8",
  },
  ".cm-panel.cm-search button[name='replaceAll']::before": {
    content: '"all"',
    fontSize: "10px",
    fontWeight: "600",
  },
  ".cm-panel.cm-search button[name='close']": {
    gridColumn: "9",
    gridRow: "1",
    fontSize: "20px",
    fontWeight: "300",
    lineHeight: "1",
  },
  ".cm-panel.cm-search button[name='close']::before": {
    content: "none",
  },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    borderRadius: "4px",
    color: "var(--text-muted)",
    fontSize: "0",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  ".cm-panel.cm-search label:hover": {
    background: "var(--surface-hover)",
    color: "var(--text)",
  },
  ".cm-panel.cm-search label input": {
    display: "none",
  },
  ".cm-panel.cm-search label::after": {
    fontSize: "12px",
    lineHeight: "1",
  },
  ".cm-panel.cm-search label:has(input:checked)": {
    color: "var(--text)",
    background: "var(--surface-hover)",
  },
  ".cm-panel.cm-search label:nth-of-type(1)": {
    gridColumn: "3",
    gridRow: "1",
  },
  ".cm-panel.cm-search label:nth-of-type(1)::after": {
    content: '"Aa"',
  },
  ".cm-panel.cm-search label:nth-of-type(2)": {
    gridColumn: "5",
    gridRow: "1",
  },
  ".cm-panel.cm-search label:nth-of-type(2)::after": {
    content: '".*"',
    fontSize: "14px",
  },
  ".cm-panel.cm-search label:nth-of-type(3)": {
    gridColumn: "4",
    gridRow: "1",
    textDecoration: "underline",
  },
  ".cm-panel.cm-search label:nth-of-type(3)::after": {
    content: '"ab"',
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, #d29922 28%, transparent)",
    outline: "1px solid color-mix(in srgb, #d29922 35%, transparent)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, #d29922 45%, transparent)",
    outline: "1px solid color-mix(in srgb, #d29922 70%, transparent)",
  },
});

export const partnerEditorHighlight = syntaxHighlighting(oneDarkHighlightStyle);
