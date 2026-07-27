import { defineStore } from "pinia";
import { computed, ref } from "vue";

export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  exited: boolean;
}

let tabSeq = 0;

function nextClientId(): string {
  tabSeq += 1;
  return `term-${Date.now()}-${tabSeq}`;
}

export const useTerminalStore = defineStore("terminal", () => {
  const open = ref(false);
  const height = ref(260);
  const tabs = ref<TerminalTab[]>([]);
  const activeTabId = ref<string | null>(null);

  const activeTab = computed(
    () => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null,
  );

  function setOpen(next: boolean) {
    open.value = next;
  }

  function toggle() {
    open.value = !open.value;
  }

  function setHeight(next: number) {
    const maxHeight =
      typeof window !== "undefined"
        ? Math.floor(window.innerHeight * 0.7)
        : 800;
    height.value = Math.max(120, Math.min(next, maxHeight));
  }

  function addTab(input: { id?: string; title: string; cwd: string }): TerminalTab {
    const tab: TerminalTab = {
      id: input.id ?? nextClientId(),
      title: input.title,
      cwd: input.cwd,
      exited: false,
    };
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    open.value = true;
    return tab;
  }

  function setActiveTab(id: string) {
    if (tabs.value.some((tab) => tab.id === id)) {
      activeTabId.value = id;
    }
  }

  function markExited(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (tab) tab.exited = true;
  }

  function updateTitle(id: string, title: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (tab && title.trim()) tab.title = title.trim();
  }

  function closeTab(id: string) {
    const index = tabs.value.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    tabs.value.splice(index, 1);
    if (activeTabId.value === id) {
      const next = tabs.value[index] ?? tabs.value[index - 1] ?? null;
      activeTabId.value = next?.id ?? null;
    }
    if (tabs.value.length === 0) {
      open.value = false;
    }
  }

  function closePanel() {
    open.value = false;
  }

  return {
    open,
    height,
    tabs,
    activeTabId,
    activeTab,
    setOpen,
    toggle,
    setHeight,
    addTab,
    setActiveTab,
    markExited,
    updateTitle,
    closeTab,
    closePanel,
  };
});
