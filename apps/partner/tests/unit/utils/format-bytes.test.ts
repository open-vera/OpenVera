import { describe, expect, it } from "vitest";
import { formatBytes, formatFileCount, usageRatio } from "@/utils/format-bytes";

describe("formatBytes", () => {
  it("renders whole bytes without a decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps up through binary units", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12_797_760)).toBe("12.2 MB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(1024 ** 4)).toBe("1 TB");
  });

  it("stays in the largest unit beyond terabytes", () => {
    expect(formatBytes(5 * 1024 ** 5)).toBe("5120 TB");
  });

  it("treats negative and non-finite input as empty", () => {
    expect(formatBytes(-10)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("formatFileCount", () => {
  it("localizes the empty case", () => {
    expect(formatFileCount(0, "zh")).toBe("空");
    expect(formatFileCount(0, "en")).toBe("empty");
  });

  it("pluralizes english counts", () => {
    expect(formatFileCount(1, "en")).toBe("1 file");
    expect(formatFileCount(2, "en")).toBe("2 files");
  });

  it("uses a measure word in chinese", () => {
    expect(formatFileCount(3, "zh")).toBe("3 个文件");
  });
});

describe("usageRatio", () => {
  it("returns the fraction of the total", () => {
    expect(usageRatio(50, 200)).toBe(0.25);
  });

  it("clamps to one", () => {
    expect(usageRatio(400, 200)).toBe(1);
  });

  it("returns zero for degenerate totals", () => {
    expect(usageRatio(10, 0)).toBe(0);
    expect(usageRatio(0, 10)).toBe(0);
    expect(usageRatio(10, Number.NaN)).toBe(0);
  });
});
