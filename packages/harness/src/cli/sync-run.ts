import { syncExternalResources } from "@open-vera/core/config";

export interface SyncRunArgs {
  force?: boolean;
}

export function runSyncCommand(args: SyncRunArgs = {}): void {
  const entries = syncExternalResources({ force: args.force });
  const counts = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log("Vera resource sync complete.");
  console.log(`  created:  ${counts.created ?? 0}`);
  console.log(`  skipped:  ${counts.skipped ?? 0}`);
  console.log(`  conflict: ${counts.conflict ?? 0}`);
  if ((counts.conflict ?? 0) > 0) {
    console.log("  Use --force to replace conflicting symlinks.");
  }
}
