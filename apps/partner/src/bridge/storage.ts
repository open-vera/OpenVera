import { invoke } from "@tauri-apps/api/core";

export async function loadPartnerSessions(projectRoot: string): Promise<unknown | null> {
  return invoke<unknown | null>("load_partner_sessions", { projectRoot });
}

export async function savePartnerSessions(
  projectRoot: string,
  data: unknown,
): Promise<void> {
  await invoke<void>("save_partner_sessions", { projectRoot, data });
}
