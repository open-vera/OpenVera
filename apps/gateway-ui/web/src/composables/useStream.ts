import { onUnmounted, ref } from "vue";
import type { TimelineEvent } from "../api";

export function useRunStream(runId: () => string | undefined) {
  const events = ref<TimelineEvent[]>([]);
  const streaming = ref(false);
  let source: EventSource | undefined;

  function connect(): void {
    disconnect();
    const id = runId();
    if (!id) return;
    streaming.value = true;
    source = new EventSource(`/api/runs/${id}/stream?live=1`);
    source.onmessage = (message) => {
      try {
        events.value = [...events.value, JSON.parse(message.data) as TimelineEvent];
      } catch {
        // ignore malformed events
      }
    };
    source.addEventListener("done", () => disconnect());
    source.onerror = () => disconnect();
  }

  function disconnect(): void {
    source?.close();
    source = undefined;
    streaming.value = false;
  }

  onUnmounted(disconnect);

  return { events, streaming, connect, disconnect };
}
