import { describe, expect, test } from "bun:test";
import {
  MAX_OVERLAY_ASSET_BYTES,
  MAX_OVERLAY_ASSET_COUNT,
  MAX_OVERLAY_ASSET_ID_LENGTH,
  MAX_OVERLAY_ASSET_TOTAL_BYTES,
  MAX_OVERLAY_FONT_ASSET_BYTES,
  OVERLAY_ASSET_MIME_TYPES,
  detectFontMimeType,
  overlayAssetIdProblem,
  overlayAssetUploadProblem,
} from "../../../src/features/overlay/overlayAssets";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const ttf = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);

describe("overlay asset contract", () => {
  test("limits match the caps the Android store enforces", () => {
    // Kotlin pins the same numbers in OverlayAssetContractTest; both read one JSON file.
    expect(MAX_OVERLAY_ASSET_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_OVERLAY_ASSET_COUNT).toBe(32);
    expect(MAX_OVERLAY_ASSET_TOTAL_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_OVERLAY_ASSET_ID_LENGTH).toBe(256);
    expect(MAX_OVERLAY_FONT_ASSET_BYTES).toBe(2 * 1024 * 1024);
    expect([...OVERLAY_ASSET_MIME_TYPES]).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "font/ttf",
      "font/otf",
    ]);
  });

  test("the per-asset cap fits inside the total cap", () => {
    expect(MAX_OVERLAY_ASSET_BYTES).toBeLessThanOrEqual(MAX_OVERLAY_ASSET_TOTAL_BYTES);
  });

  test("accepts each allowed type at the exact byte boundary", () => {
    for (const mimeType of OVERLAY_ASSET_MIME_TYPES.filter((type) => type.startsWith("image/"))) {
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

  test("fonts are checked by sfnt signature and a tighter size cap, not decoded as images", () => {
    const otf = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x00]);
    expect(overlayAssetUploadProblem({ id: "f", mimeType: "font/ttf", bytes: ttf })).toBeNull();
    expect(overlayAssetUploadProblem({ id: "f", mimeType: "font/otf", bytes: otf })).toBeNull();
    expect(overlayAssetUploadProblem({ id: "f", mimeType: "font/ttf", bytes: png })).toContain(
      "not a TrueType or OpenType font",
    );
    const exact = new Uint8Array(MAX_OVERLAY_FONT_ASSET_BYTES);
    exact.set(ttf);
    expect(overlayAssetUploadProblem({ id: "f", mimeType: "font/ttf", bytes: exact })).toBeNull();
    const over = new Uint8Array(MAX_OVERLAY_FONT_ASSET_BYTES + 1);
    over.set(ttf);
    expect(overlayAssetUploadProblem({ id: "f", mimeType: "font/ttf", bytes: over })).toContain(
      `the limit is ${MAX_OVERLAY_FONT_ASSET_BYTES}`,
    );
  });

  test("detectFontMimeType recognises 0x00010000, true and OTTO only", () => {
    expect(detectFontMimeType(new Uint8Array([0, 1, 0, 0]))).toBe("font/ttf");
    expect(detectFontMimeType(new TextEncoder().encode("true"))).toBe("font/ttf");
    expect(detectFontMimeType(new TextEncoder().encode("OTTO"))).toBe("font/otf");
    expect(detectFontMimeType(new TextEncoder().encode("ttcf"))).toBeNull();
    expect(detectFontMimeType(new TextEncoder().encode("wOFF"))).toBeNull();
    expect(detectFontMimeType(png)).toBeNull();
    expect(detectFontMimeType(new Uint8Array([0, 1, 0]))).toBeNull();
  });

  test("ids are opaque: any nonempty string up to the cap", () => {
    for (const id of ["a", "variant-b", "../etc", "a/b", "snow☃", "x".repeat(256)]) {
      expect(overlayAssetIdProblem(id)).toBeNull();
    }
    expect(overlayAssetIdProblem("")).not.toBeNull();
    expect(overlayAssetIdProblem("x".repeat(257))).not.toBeNull();
  });
});
