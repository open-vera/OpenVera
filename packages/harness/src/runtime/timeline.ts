import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore, TimelineEntry } from "./internal.js";

export async function createArtifactStore(
  rootDir: string,
  flowId: string
): Promise<ArtifactStore> {
  const flowDir = join(rootDir, flowId);
  await mkdir(flowDir, { recursive: true });
  await mkdir(join(flowDir, "artifacts"), { recursive: true });
  return { rootDir, flowDir };
}

export async function appendTimeline(
  store: ArtifactStore,
  entry: TimelineEntry
): Promise<void> {
  const path = join(store.flowDir, "timeline.ndjson");
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
}
