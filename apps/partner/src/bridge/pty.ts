import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { hostDispatch } from "@/shell";

export interface PtySpawnResult {
  id: string;
  title: string;
}

export interface PtyDataEvent {
  id: string;
  data: string;
}

export interface PtyExitEvent {
  id: string;
  code: number | null;
}

/** PTY goes through Workbench Host (`host.pty.*`). */
export async function ptySpawn(params: {
  cwd?: string;
  cols?: number;
  rows?: number;
}): Promise<PtySpawnResult> {
  return hostDispatch<PtySpawnResult>({
    op: "host.pty.spawn",
    cwd: params.cwd ?? null,
    cols: params.cols,
    rows: params.rows,
  });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  await hostDispatch({
    op: "host.pty.write",
    id,
    data,
  });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  await hostDispatch({
    op: "host.pty.resize",
    id,
    cols,
    rows,
  });
}

export async function ptyKill(id: string): Promise<void> {
  await hostDispatch({
    op: "host.pty.kill",
    id,
  });
}

export async function onPtyData(
  handler: (payload: PtyDataEvent) => void,
): Promise<UnlistenFn> {
  return listen<PtyDataEvent>("pty:data", (event) => handler(event.payload));
}

export async function onPtyExit(
  handler: (payload: PtyExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>("pty:exit", (event) => handler(event.payload));
}
