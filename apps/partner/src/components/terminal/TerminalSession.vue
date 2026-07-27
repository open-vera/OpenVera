<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  onPtyData,
  onPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "@/bridge/pty";
import { useTerminalStore } from "@/stores/terminal";

const props = defineProps<{
  tabId: string;
  cwd: string;
  active: boolean;
}>();

const emit = defineEmits<{
  ready: [payload: { tabId: string; ptyId: string; title: string }];
  exited: [tabId: string];
}>();

const hostRef = ref<HTMLElement | null>(null);
const terminalStore = useTerminalStore();

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ptyId: string | null = null;
let unlistenData: (() => void) | undefined;
let unlistenExit: (() => void) | undefined;
let resizeObserver: ResizeObserver | null = null;
let disposed = false;

function themeFromCss(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: "#000000",
    foreground: read("--text", "#e5e7eb"),
    cursor: read("--accent", "#38bdf8"),
    selectionBackground: "rgba(56, 189, 248, 0.35)",
  };
}

async function fitAndResize() {
  if (!term || !fitAddon || !ptyId || !props.active) return;
  fitAddon.fit();
  try {
    await ptyResize(ptyId, term.cols, term.rows);
  } catch {
    // Session may have exited.
  }
}

async function startSession() {
  if (!hostRef.value || disposed) return;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    theme: themeFromCss(),
    scrollback: 5000,
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(hostRef.value);
  fitAddon.fit();

  const spawned = await ptySpawn({
    cwd: props.cwd || undefined,
    cols: term.cols,
    rows: term.rows,
  });
  if (disposed) {
    await ptyKill(spawned.id).catch(() => undefined);
    return;
  }
  ptyId = spawned.id;
  emit("ready", { tabId: props.tabId, ptyId: spawned.id, title: spawned.title });
  terminalStore.updateTitle(props.tabId, spawned.title);

  term.onData((data) => {
    if (!ptyId) return;
    void ptyWrite(ptyId, data).catch(() => undefined);
  });

  unlistenData = await onPtyData((payload) => {
    if (payload.id !== ptyId || !term) return;
    term.write(payload.data);
  });

  unlistenExit = await onPtyExit((payload) => {
    if (payload.id !== ptyId || !term) return;
    const code = payload.code ?? 0;
    term.writeln(`\r\n[process exited with code ${code}]`);
    terminalStore.markExited(props.tabId);
    emit("exited", props.tabId);
    ptyId = null;
  });

  resizeObserver = new ResizeObserver(() => {
    void fitAndResize();
  });
  resizeObserver.observe(hostRef.value);
  await fitAndResize();
}

async function dispose() {
  disposed = true;
  resizeObserver?.disconnect();
  resizeObserver = null;
  unlistenData?.();
  unlistenExit?.();
  unlistenData = undefined;
  unlistenExit = undefined;
  if (ptyId) {
    await ptyKill(ptyId).catch(() => undefined);
    ptyId = null;
  }
  term?.dispose();
  term = null;
  fitAddon = null;
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      void fitAndResize();
      term?.focus();
    }
  },
);

onMounted(() => {
  void startSession().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    term?.writeln(`\r\n[failed to start terminal: ${message}]`);
    terminalStore.markExited(props.tabId);
  });
});

onBeforeUnmount(() => {
  void dispose();
});

defineExpose({
  focus: () => term?.focus(),
  fit: () => void fitAndResize(),
});
</script>

<template>
  <div
    ref="hostRef"
    class="terminal-session"
    :class="{ active }"
    data-shortcut-scope="bottom"
  />
</template>

<style scoped>
.terminal-session {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #000;
  display: none;
}

.terminal-session.active {
  display: block;
}

.terminal-session :deep(.xterm) {
  height: 100%;
  padding: 4px 8px 8px;
}

.terminal-session :deep(.xterm-viewport) {
  overflow-y: auto !important;
}
</style>
