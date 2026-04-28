import { ref, onUnmounted } from "vue";
import { openStream } from "../api";
import type { TimelineEvent } from "../types";

export function useStream(runId: string) {
  const events = ref<TimelineEvent[]>([]);
  const done = ref(false);

  const close = openStream(
    runId,
    (ev) => events.value.push(ev),
    () => { done.value = true; }
  );

  onUnmounted(close);

  return { events, done, close };
}
