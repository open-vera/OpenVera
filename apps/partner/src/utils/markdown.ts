import MarkdownIt from "markdown-it";

function escapeHtml(source: string): string {
  return source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function span(className: string, value: string): string {
  return `<span class="${className}">${escapeHtml(value)}</span>`;
}

function highlightShellLine(line: string): string {
  if (/^\s*#/.test(line)) {
    return span("token-comment", line);
  }

  let escaped = escapeHtml(line);
  escaped = escaped.replace(
    /(&quot;(?:\\.|(?!(?:&quot;)).)*&quot;|'(?:\\.|[^'\\])*')/g,
    '<span class="token-string">$1</span>',
  );
  escaped = escaped.replace(
    /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|in|echo|export|local|return|exit|set|cd|read)\b/g,
    '<span class="token-keyword">$1</span>',
  );
  escaped = escaped.replace(
    /(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\([^)]*\))/g,
    '<span class="token-variable">$1</span>',
  );
  return escaped;
}

function highlightJson(source: string): string {
  return escapeHtml(source)
    .replace(/("(?:\\.|[^"\\])*")(\s*:)?/g, (_match, keyOrString: string, colon: string = "") => {
      const className = colon ? "token-property" : "token-string";
      return `<span class="${className}">${keyOrString}</span>${colon}`;
    })
    .replace(/\b(true|false|null)\b/g, '<span class="token-literal">$1</span>')
    .replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="token-number">$1</span>');
}

function highlightGeneric(source: string): string {
  return escapeHtml(source)
    .replace(/(\/\/.*|#.*)/g, '<span class="token-comment">$1</span>')
    .replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, '<span class="token-string">$1</span>')
    .replace(
      /\b(const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|try|catch|throw|new)\b/g,
      '<span class="token-keyword">$1</span>',
    )
    .replace(/\b(true|false|null|undefined)\b/g, '<span class="token-literal">$1</span>')
    .replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="token-number">$1</span>');
}

function highlightCode(source: string, language: string): string {
  const normalizedLanguage = language.toLowerCase().trim();
  if (["bash", "sh", "shell", "zsh"].includes(normalizedLanguage)) {
    return source.split("\n").map(highlightShellLine).join("\n");
  }
  if (["json", "jsonc"].includes(normalizedLanguage)) {
    return highlightJson(source);
  }
  return highlightGeneric(source);
}

function codeBlockLanguageLabel(language: string): string {
  return escapeHtml(language.trim() || "code");
}

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true,
});

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0] ?? "";
  const highlighted = highlightCode(token.content, language);
  const languageClass = language ? ` language-${escapeHtml(language)}` : "";
  const copyText = encodeURIComponent(token.content);
  return `<div class="code-block-shell"><button type="button" class="code-copy-button" data-code="${copyText}" aria-label="复制代码">复制</button><span class="code-language">${codeBlockLanguageLabel(language)}</span><pre class="code-block${languageClass}"><code>${highlighted}</code></pre><div class="code-fade"><button type="button" class="code-expand-button">展开</button></div></div>`;
};

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
