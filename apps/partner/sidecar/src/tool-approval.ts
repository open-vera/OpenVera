const DEFAULT_TIMEOUT_MS = 300_000;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

export function waitForToolApproval(
  callId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(callId);
      resolve(false);
    }, timeoutMs);

    pendingApprovals.set(callId, {
      resolve: (approved) => {
        clearTimeout(timer);
        resolve(approved);
      },
      timer,
    });
  });
}

export function resolveToolApproval(callId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(callId);
  if (!pending) return false;
  pendingApprovals.delete(callId);
  clearTimeout(pending.timer);
  pending.resolve(approved);
  return true;
}
