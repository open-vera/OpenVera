import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendRunLogLine,
  buildRunLogPath,
  formatRunLogLine,
  runLogProjectDir,
  runLogProjectSlug,
  runLogSegment,
} from "../../../sidecar/src/run-log.js";

const originalVeraHome = process.env.VERA_HOME;

describe("runLogProjectSlug", () => {
  // These expectations are duplicated in src-tauri/src/paths.rs — the sidecar
  // writes the path and the Rust host resolves it, so both must agree.
  it("flattens an absolute posix path", () => {
    expect(runLogProjectSlug("/Users/dev/workspace/open-vera")).toBe(
      "-Users-dev-workspace-open-vera",
    );
  });

  it("replaces dots too", () => {
    expect(runLogProjectSlug("/Users/yang.zhou/workspace/open-vera")).toBe(
      "-Users-yang-zhou-workspace-open-vera",
    );
  });

  it("does not collapse separator runs", () => {
    expect(runLogProjectSlug("/a//b")).toBe("-a--b");
    expect(runLogProjectSlug("/a-b")).toBe("-a-b");
  });

  it("replaces non-ascii per utf16 unit", () => {
    expect(runLogProjectSlug("/a/项目")).toBe("-a---");
    expect(runLogProjectSlug("C:\\work\\app")).toBe("C--work-app");
  });

  it("is empty for an empty path", () => {
    expect(runLogProjectSlug("")).toBe("");
  });

  it("hashes paths longer than the directory limit", () => {
    const long = `/${"a".repeat(120)}`;
    const slug = runLogProjectSlug(long);

    expect(slug).toHaveLength(87);
    expect(slug.endsWith("-xt6otw")).toBe(true);
    expect(slug).not.toBe(runLogProjectSlug(`/${"a".repeat(119)}b`));
  });
});

describe("runLogSegment", () => {
  it("sanitizes task ids", () => {
    expect(runLogSegment("task:1")).toBe("task_1");
    expect(runLogSegment("a/b")).toBe("a_b");
    expect(runLogSegment("x".repeat(200)).length).toBe(120);
  });
});

describe("run log paths", () => {
  beforeEach(() => {
    process.env.VERA_HOME = mkdtempSync(join(tmpdir(), "partner-run-log-"));
  });

  afterEach(() => {
    if (originalVeraHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = originalVeraHome;
  });

  it("puts task logs under the global vera directory, not the project", () => {
    const home = process.env.VERA_HOME as string;
    const path = buildRunLogPath(
      "/Users/dev/proj",
      new Date("2026-07-27T10:51:00.000Z"),
      "task:1",
    );

    expect(path).toBe(
      join(home, ".vera/partner-runs/-Users-dev-proj/2026-07-27/task_1.jsonl"),
    );
    expect(path).not.toContain("/Users/dev/proj/.vera");
  });

  it("uses a shared file when there is no task id", () => {
    const path = buildRunLogPath("/Users/dev/proj", new Date("2026-07-27T10:51:00.000Z"));

    expect(path).toBe(join(runLogProjectDir("/Users/dev/proj"), "2026-07-27/general.jsonl"));
  });

  it("keys the day directory off UTC", () => {
    const path = buildRunLogPath("/p", new Date("2026-07-27T23:30:00.000Z"), "t");

    expect(path).toContain("/2026-07-27/");
  });
});

describe("formatRunLogLine", () => {
  it("stamps the timestamp and task id ahead of the record", () => {
    const line = formatRunLogLine(
      { event: "run_start", messagePreview: "hi" },
      "task-1",
      new Date("2026-07-27T10:51:00.000Z"),
    );

    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-07-27T10:51:00.000Z",
      taskId: "task-1",
      event: "run_start",
      messagePreview: "hi",
    });
    expect(line.endsWith("\n")).toBe(true);
  });

  it("omits the task id when absent", () => {
    const line = formatRunLogLine({ event: "boot" }, undefined, new Date(0));

    expect(JSON.parse(line)).not.toHaveProperty("taskId");
  });

  it("lets the record override the injected task id", () => {
    const line = formatRunLogLine({ event: "x", taskId: "from-record" }, "outer", new Date(0));

    expect(JSON.parse(line).taskId).toBe("from-record");
  });
});

describe("appendRunLogLine", () => {
  beforeEach(() => {
    process.env.VERA_HOME = mkdtempSync(join(tmpdir(), "partner-run-log-"));
  });

  afterEach(() => {
    if (originalVeraHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = originalVeraHome;
  });

  it("creates missing directories and appends one record per call", () => {
    const date = new Date("2026-07-27T10:51:00.000Z");
    const first = appendRunLogLine("/Users/dev/proj", { event: "a" }, "task-1", date);
    const second = appendRunLogLine("/Users/dev/proj", { event: "b" }, "task-1", date);

    expect(second).toBe(first);
    const lines = readFileSync(first, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("a");
    expect(JSON.parse(lines[1]).event).toBe("b");
  });

  it("separates tasks into their own files", () => {
    const date = new Date("2026-07-27T10:51:00.000Z");
    const a = appendRunLogLine("/p", { event: "a" }, "task-a", date);
    const b = appendRunLogLine("/p", { event: "b" }, "task-b", date);

    expect(a).not.toBe(b);
  });
});
