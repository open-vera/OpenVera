import {
  getBackgroundSubagentJob,
  listBackgroundSubagentJobs,
} from "../../agent/subagent.js";
import type { ReplContext } from "../context.js";

export async function subjobsCommand(args: string[], _ctx: ReplContext): Promise<void> {
  const query = args.find((arg) => !arg.startsWith("--"));
  if (query) {
    const job = getBackgroundSubagentJob(query);
    if (!job) {
      console.log(`No background subagent job found for "${query}".`);
      return;
    }
    console.log(
      [
        `Job ${job.jobId} · ${job.status}`,
        `Agent: ${job.agentType}`,
        `Created: ${job.createdAt}`,
        `Updated: ${job.updatedAt}`,
        job.transcriptId ? `Transcript: ${job.transcriptId}` : "",
        job.result ? `Result: ${truncate(job.result, 260)}` : "",
        job.error ? `Error: ${truncate(job.error, 260)}` : "",
      ].filter(Boolean).join("\n"),
    );
    return;
  }

  const jobs = listBackgroundSubagentJobs();
  if (jobs.length === 0) {
    console.log("No background subagent jobs.");
    return;
  }

  console.log("Background subagent jobs:");
  for (const job of jobs.slice(0, 20)) {
    console.log(
      `  ${job.jobId.slice(0, 18).padEnd(18)}  ${job.status.padEnd(9)}  ${job.agentType.padEnd(14)}  ` +
      `${job.transcriptId?.slice(0, 8) ?? "--------"}  ${truncate(job.prompt, 48)}`,
    );
  }
}

function truncate(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, Math.max(0, max - 3))}...`;
}

