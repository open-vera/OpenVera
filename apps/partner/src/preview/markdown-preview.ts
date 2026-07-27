import type { PreviewLanguageId } from "./language.js";

/** How a language should be rendered in the editor preview pane. */
export type DocumentPreviewKind = "markdown" | "html" | "text";

/** Languages that support rendered preview from the editor toolbar / context menu. */
export function previewKindForLanguage(
  language: PreviewLanguageId | null | undefined,
): DocumentPreviewKind | null {
  switch (language) {
    case "markdown":
      return "markdown";
    case "html":
      return "html";
    case "plaintext":
      return "text";
    default:
      return null;
  }
}

export function canPreviewLanguage(language: PreviewLanguageId | null | undefined): boolean {
  return previewKindForLanguage(language) !== null;
}
