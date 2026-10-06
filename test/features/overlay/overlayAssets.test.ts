import { describe, expect, test } from "bun:test";
import {
  MAX_OVERLAY_ASSET_BYTES,
  MAX_OVERLAY_ASSET_COUNT,
  MAX_OVERLAY_ASSET_ID_LENGTH,
  MAX_OVERLAY_ASSET_TOTAL_BYTES,
  OVERLAY_ASSET_MIME_TYPES,
  overlayAssetIdProblem,
  overlayAssetUploadProblem,
} from "../../../src/features/overlay/overlayAssets";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("overlay asset contract", () => {
  test("limits match the caps the Android store enforces", () => {
    // Kotlin pins the same numbers in OverlayAssetContractTest; both read one JSON file.
    expect(MAX_OVERLAY_ASSET_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_OVERLAY_ASSET_COUNT).toBe(32);
    expect(MAX_OVERLAY_ASSET_TOTAL_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_OVERLAY_ASSET_ID_LENGTH).toBe(256);
    expect([...OVERLAY_ASSET_MIME_TYPES]).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  test("the per-asset cap fits inside the total cap", () => {
    expect(MAX_OVERLAY_ASSET_BYTES).toBeLessThanOrEqual(MAX_OVERLAY_ASSET_TOTAL_BYTES);
  });

  test("accepts each allowed type at the exact byte boundary", () => {
    for (const mimeType of OVERLAY_ASSET_MIME_TYPES) {
      expect(overlayAssetUploadProblem({ id: "a", mimeType, bytes: png })).toBeNull();
      expect(
        overlayAssetUploadProblem({
          id: "a",
          mimeType,
          bytes: new Uint8Array(MAX_OVERLAY_ASSET_BYTES),
        }),
      ).toBeNull();
    }
  });

  test("names the first problem for each invalid upload", () => {
    const base = { id: "a", mimeType: "image/png" as const, bytes: png };
    expect(overlayAssetUploadProblem({ ...base, id: "" })).toContain("id must be");
    expect(overlayAssetUploadProblem({ ...base, mimeType: "image/gif" as "image/png" })).toContain(
      "Unsupported overlay asset MIME type",
    );
    expect(overlayAssetUploadProblem({ ...base, bytes: new Uint8Array(0) })).toContain("no data");
    expect(
      overlayAssetUploadProblem({ ...base, bytes: new Uint8Array(MAX_OVERLAY_ASSET_BYTES + 1) }),
    ).toContain(`the limit is ${MAX_OVERLAY_ASSET_BYTES}`);
  });

  test("ids are opaque: any nonempty string up to the cap", () => {
    for (const id of ["a", "variant-b", "../etc", "a/b", "snow☃", "x".repeat(256)]) {
      expect(overlayAssetIdProblem(id)).toBeNull();
    }
    expect(overlayAssetIdProblem("")).not.toBeNull();
    expect(overlayAssetIdProblem("x".repeat(257))).not.toBeNull();
  });
});
