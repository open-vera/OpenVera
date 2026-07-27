import { ask, message } from "@tauri-apps/plugin-dialog";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Yes/No confirm. Uses native dialog in Tauri; window.confirm in browser. */
export async function confirmDialog(
  text: string,
  options?: { title?: string },
): Promise<boolean> {
  if (isTauriRuntime()) {
    return ask(text, {
      title: options?.title ?? "Partner",
      kind: "warning",
    });
  }
  return window.confirm(text);
}

/** Info/error alert. Uses native dialog in Tauri; window.alert in browser. */
export async function alertDialog(
  text: string,
  options?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<void> {
  if (isTauriRuntime()) {
    await message(text, {
      title: options?.title ?? "Partner",
      kind: options?.kind ?? "info",
    });
    return;
  }
  window.alert(text);
}
