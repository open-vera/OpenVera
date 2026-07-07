import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true,
});

function stripChatSeparators(source: string): string {
  let inFence = false;
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (/^(```|~~~)/.test(trimmed)) {
        inFence = !inFence;
        return true;
      }
      if (inFence) return true;
      return !/^([-*_])(?:\s*\1){2,}$/.test(trimmed);
    })
    .join("\n");
}

export function renderMarkdown(source: string): string {
  return markdown.render(stripChatSeparators(source));
}
