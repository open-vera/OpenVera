import { describe, expect, it } from "vitest";
import { fileUriToPath, pathToFileUri } from "@/preview/file-uri";

describe("file-uri", () => {
  it("round-trips unix paths", () => {
    expect(pathToFileUri("/Users/me/app.ts")).toBe("file:///Users/me/app.ts");
    expect(fileUriToPath("file:///Users/me/app.ts")).toBe("/Users/me/app.ts");
  });

  it("decodes percent-encoded paths", () => {
    expect(fileUriToPath("file:///Users/me/my%20file.ts")).toBe("/Users/me/my file.ts");
  });

  it("handles localhost URIs", () => {
    expect(fileUriToPath("file://localhost/Users/me/app.ts")).toBe("/Users/me/app.ts");
  });
});
