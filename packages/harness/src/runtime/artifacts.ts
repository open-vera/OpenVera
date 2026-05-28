import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ArtifactRecord } from "@open-vera/core/types";
import type { ArtifactStore } from "./internal.js";

export async function writeArtifact(
  store: ArtifactStore,
  artifact: ArtifactRecord,
  content: string
): Promise<ArtifactRecord> {
  const fileName = `${artifact.id}.json`;
  const path = join(store.flowDir, "artifacts", fileName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return {
    ...artifact,
    uri: path,
  };
}
