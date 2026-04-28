import type { PendingAction } from "@vera/core/types";
import type { ApprovalDecision, ApprovalRecord } from "./internal.js";

export function createApprovalRecord(
  action: PendingAction,
  decision: ApprovalDecision
): ApprovalRecord {
  return {
    action,
    decision,
    decidedAt: new Date().toISOString(),
  };
}

export function shouldPauseForApproval(record: ApprovalRecord): boolean {
  return !record.decision.approved;
}
