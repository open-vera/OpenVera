<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { renderMarkdownAsync } from "@/utils/markdown-worker-client";

const props = defineProps<{
  content: string;
}>();

const rendered = ref("");
const rendererRef = ref<HTMLElement | null>(null);
const CODE_BLOCK_MAX_HEIGHT = 800;
let renderSeq = 0;

function setupCodeBlockOverflow() {
  const root = rendererRef.value;
  if (!root) return;
  for (const shell of root.querySelectorAll<HTMLElement>(".code-block-shell")) {
    const pre = shell.querySelector<HTMLElement>("pre");
    if (!pre) continue;
    shell.classList.remove("is-collapsible", "is-expanded");
    if (pre.scrollHeight > CODE_BLOCK_MAX_HEIGHT) {
      shell.classList.add("is-collapsible");
    }
  }
}

watch(
  () => props.content,
  (content) => {
    const seq = ++renderSeq;
    void renderMarkdownAsync(content)
      .then((html) => {
        if (seq !== renderSeq) return;
        rendered.value = html;
        void nextTick(() => {
          requestAnimationFrame(setupCodeBlockOverflow);
        });
      })
      .catch((error: unknown) => {
        if (seq !== renderSeq) return;
        console.warn("[MarkdownRenderer] worker render failed:", error);
        rendered.value = "";
      });
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  renderSeq += 1;
});

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function markCopyState(button: HTMLButtonElement, label: string) {
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = "复制";
  }, 1200);
}

async function onMarkdownClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const toggle = target.closest<HTMLButtonElement>(".code-expand-button");
  if (toggle) {
    event.preventDefault();
    event.stopPropagation();
    const shell = toggle.closest<HTMLElement>(".code-block-shell");
    if (!shell) return;
    const expanded = shell.classList.toggle("is-expanded");
    toggle.textContent = expanded ? "收起" : "展开";
    return;
  }

  const button = target.closest<HTMLButtonElement>(".code-copy-button");
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  const encoded = button.dataset.code;
  if (!encoded) return;
  try {
    await copyText(decodeURIComponent(encoded));
    markCopyState(button, "已复制");
  } catch (error) {
    markCopyState(button, "失败");
    console.warn("[MarkdownRenderer] failed to copy code block:", error);
  }
}
</script>

<template>
  <div ref="rendererRef" class="markdown-renderer" @click="onMarkdownClick" v-html="rendered" />
</template>

<style scoped>
.markdown-renderer {
  color: var(--text);
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.markdown-renderer :deep(*) {
  margin-top: 0;
}

.markdown-renderer :deep(*:last-child) {
  margin-bottom: 0;
}

.markdown-renderer :deep(p) {
  margin: 0 0 10px;
}

.markdown-renderer :deep(ul),
.markdown-renderer :deep(ol) {
  margin: 0 0 12px;
  padding-left: 24px;
}

.markdown-renderer :deep(li + li) {
  margin-top: 5px;
}

.markdown-renderer :deep(li > p) {
  margin-bottom: 6px;
}

.markdown-renderer :deep(li::marker) {
  color: var(--accent);
  font-weight: 700;
}

.markdown-renderer :deep(blockquote) {
  margin: 0 0 10px;
  padding-left: 12px;
  border-left: 3px solid var(--border);
  color: var(--text-muted);
}

.markdown-renderer :deep(pre) {
  margin: 0 0 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  border-radius: 8px;
  background: var(--surface-inset);
  overflow-x: auto;
  white-space: pre;
}

.markdown-renderer :deep(.code-block-shell) {
  position: relative;
  margin: 0 0 10px;
}

.markdown-renderer :deep(.code-block-shell pre) {
  margin-bottom: 0;
  padding-top: 30px;
}

.markdown-renderer :deep(.code-block-shell.is-collapsible:not(.is-expanded) pre) {
  max-height: 800px;
  overflow: hidden;
}

.markdown-renderer :deep(.code-block-shell.is-expanded pre) {
  max-height: none;
}

.markdown-renderer :deep(.code-copy-button) {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 1;
  height: 24px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 6px;
  padding: 0 8px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  line-height: 22px;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 120ms ease,
    background 120ms ease,
    color 120ms ease;
}

.markdown-renderer :deep(.code-block-shell:hover .code-copy-button),
.markdown-renderer :deep(.code-copy-button:focus-visible) {
  opacity: 1;
}

.markdown-renderer :deep(.code-copy-button:hover) {
  background: var(--surface-hover);
  color: var(--text);
}

.markdown-renderer :deep(.code-language) {
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 1;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 20px;
  pointer-events: none;
}

.markdown-renderer :deep(.code-fade) {
  display: none;
}

.markdown-renderer :deep(.code-block-shell.is-collapsible .code-fade) {
  position: absolute;
  right: 1px;
  bottom: 1px;
  left: 1px;
  display: flex;
  justify-content: center;
  padding: 34px 12px 10px;
  border-radius: 0 0 8px 8px;
  background: linear-gradient(
    to bottom,
    transparent,
    color-mix(in srgb, var(--surface-inset) 84%, var(--bg)) 54%,
    color-mix(in srgb, var(--surface-inset) 92%, var(--bg))
  );
  pointer-events: none;
}

.markdown-renderer :deep(.code-block-shell.is-expanded .code-fade) {
  position: static;
  padding: 8px 12px 10px;
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  border-top: none;
  border-radius: 0 0 8px 8px;
  background: var(--surface-inset);
}

.markdown-renderer :deep(.code-block-shell.is-expanded pre) {
  border-radius: 8px 8px 0 0;
}

.markdown-renderer :deep(.code-expand-button) {
  height: 26px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
  border-radius: 999px;
  padding: 0 12px;
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  pointer-events: auto;
}

.markdown-renderer :deep(.code-expand-button:hover) {
  background: var(--surface-hover);
}

.markdown-renderer :deep(code) {
  border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  background: color-mix(in srgb, var(--surface-elevated) 86%, transparent);
  color: color-mix(in srgb, var(--text) 94%, var(--accent));
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
}

.markdown-renderer :deep(pre code) {
  border: none;
  padding: 0;
  color: inherit;
  background: transparent;
}

.markdown-renderer :deep(.code-block code) {
  color: color-mix(in srgb, var(--text) 88%, var(--token-string, #a5d6ff));
}

.markdown-renderer :deep(.token-comment) {
  color: var(--token-comment, #8b949e);
  font-style: italic;
}

.markdown-renderer :deep(.token-keyword) {
  color: var(--token-keyword, #ff7b72);
  font-weight: 650;
}

.markdown-renderer :deep(.token-string) {
  color: var(--token-string, #a5d6ff);
}

.markdown-renderer :deep(.token-variable) {
  color: var(--token-variable, #ffa657);
}

.markdown-renderer :deep(.token-property) {
  color: var(--token-property, #79c0ff);
}

.markdown-renderer :deep(.token-number),
.markdown-renderer :deep(.token-literal) {
  color: var(--token-number, #79c0ff);
}

.markdown-renderer :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.markdown-renderer :deep(a:hover) {
  text-decoration: underline;
}

.markdown-renderer :deep(table) {
  display: block;
  width: 100%;
  margin: 2px 0 12px;
  border-collapse: separate;
  border-spacing: 0;
  overflow-x: auto;
}

.markdown-renderer :deep(th),
.markdown-renderer :deep(td) {
  border: 1px solid var(--border);
  padding: 7px 9px;
  vertical-align: top;
}

.markdown-renderer :deep(th) {
  background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface));
  color: var(--text);
  font-weight: 650;
}

.markdown-renderer :deep(td) {
  color: color-mix(in srgb, var(--text) 92%, var(--text-muted));
}

.markdown-renderer :deep(hr) {
  display: none;
}
</style>
