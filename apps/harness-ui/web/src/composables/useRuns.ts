import { ref, onUnmounted } from "vue";
import { api } from "../api";
import type { RunSummary } from "../types";

export function useRuns() {
  const runs = ref<RunSummary[]>([]);
  const loading = ref(false);
  const error = ref<string>();

  async function load() {
    loading.value = true;
    error.value = undefined;
    try {
      runs.value = await api.runs.list();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  // Poll every 5s while any run is in "running" state
  let timer: ReturnType<typeof setInterval> | undefined;

  function startPolling() {
    stopPolling();
    timer = setInterval(() => {
      if (runs.value.some((r) => r.status === "running")) {
        void load();
      }
    }, 5000);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  onUnmounted(stopPolling);

  return { runs, loading, error, load, startPolling, stopPolling };
}
