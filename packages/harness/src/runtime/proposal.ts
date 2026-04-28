import type { PolicyProposal } from "@vera/core/types";
import type { CreateProposalInput, ProposalBundle } from "./internal.js";

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

export function createProposal(input: CreateProposalInput): PolicyProposal {
  return {
    proposalId: input.proposalId ?? randomId("proposal"),
    source: input.source,
    category: input.category,
    hypothesis: input.hypothesis,
    patch: input.patch,
    expectedImpact: input.expectedImpact,
    status: "draft",
  };
}

export function createProposalFromRetrospective(
  rationale: string,
  input: CreateProposalInput
): ProposalBundle {
  return {
    proposal: createProposal(input),
    rationale,
  };
}
