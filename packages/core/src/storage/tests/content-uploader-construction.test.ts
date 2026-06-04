/**
 * ContentUploader unit tests — construction.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ContentUploader, createContentUploader } from "../content-uploader.js";
import type { ObjectStore } from "../object-store.js";
import { createMockStore } from "./content-uploader-test-helpers.js";

describe("ContentUploader construction", () => {
  let mockStore: ObjectStore;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  it("constructs with minimum required options", () => {
    const uploader = new ContentUploader({ store: mockStore });
    expect(uploader).toBeInstanceOf(ContentUploader);
  });

  it("createContentUploader factory returns a ContentUploader instance", () => {
    const uploader = createContentUploader({ store: mockStore });
    expect(uploader).toBeInstanceOf(ContentUploader);
  });

  it("accepts all optional options", () => {
    const uploader = new ContentUploader({
      store: mockStore,
      prefix: "uploads/",
      generateUrls: false,
      urlExpiry: 1800,
      defaultContentType: "application/json",
    });
    expect(uploader).toBeInstanceOf(ContentUploader);
  });
});

// ── Upload: Basic Content Types ─────────────────────────────────────────────
