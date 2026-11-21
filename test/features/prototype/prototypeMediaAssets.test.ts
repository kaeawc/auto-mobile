import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-asset-contract.json";
import cases from "../../fixtures/prototype-media-transport/cases.json";
import {
  MAX_PROTOTYPE_ASSET_TOTAL_BYTES,
  MAX_PROTOTYPE_ASSET_BYTES,
  PROTOTYPE_ASSET_MIME_TYPES,
} from "../../../src/features/prototype/prototypeAssets";
import {
  MAX_PROTOTYPE_MEDIA_ASSET_BYTES,
  MAX_PROTOTYPE_MEDIA_ASSET_COUNT,
  MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES,
  MAX_PROTOTYPE_MEDIA_CHUNK_BYTES,
  MAX_PROTOTYPE_VTT_ASSET_BYTES,
  PROTOTYPE_MEDIA_MIME_TYPES,
  PROTOTYPE_MEDIA_REJECTIONS,
  PROTOTYPE_MEDIA_SIGNATURE_PROBE_BYTES,
  isPrototypeMediaMimeType,
  prototypeMediaBeginProblem,
  prototypeMediaSignatureMatches,
} from "../../../src/features/prototype/prototypeMediaAssets";

const MiB = 1024 * 1024;

describe("prototype media asset contract", () => {
  test("media budget is separate from the image and font budget", () => {
    expect(contract.media.limits).toEqual({
      MAX_PROTOTYPE_MEDIA_ASSET_BYTES: 64 * MiB,
      MAX_PROTOTYPE_VTT_ASSET_BYTES: 256 * 1024,
      MAX_PROTOTYPE_MEDIA_ASSET_COUNT: 16,
      MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES: 128 * MiB,
      MAX_PROTOTYPE_MEDIA_CHUNK_BYTES: MiB,
    });
    expect(MAX_PROTOTYPE_MEDIA_ASSET_BYTES).toBe(64 * MiB);
    expect(MAX_PROTOTYPE_MEDIA_ASSET_COUNT).toBe(16);
    expect(MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES).toBe(128 * MiB);
    expect(MAX_PROTOTYPE_VTT_ASSET_BYTES).toBe(256 * 1024);
    expect(MAX_PROTOTYPE_MEDIA_CHUNK_BYTES).toBe(MiB);
    expect(MAX_PROTOTYPE_ASSET_BYTES).toBe(4 * MiB);
    expect(MAX_PROTOTYPE_ASSET_TOTAL_BYTES).toBe(16 * MiB);
  });

  test("media types never enter the single-frame asset allowlist", () => {
    expect<readonly string[]>(PROTOTYPE_MEDIA_MIME_TYPES).toEqual(contract.media.mimeTypes);
    for (const type of PROTOTYPE_MEDIA_MIME_TYPES) {
      expect(PROTOTYPE_ASSET_MIME_TYPES as readonly string[]).not.toContain(type);
      expect(isPrototypeMediaMimeType(type)).toBe(true);
    }
    expect(isPrototypeMediaMimeType("image/png")).toBe(false);
  });

  test("a chunk's base64 stays far below the inbound frame cap", () => {
    expect(Math.ceil(MAX_PROTOTYPE_MEDIA_CHUNK_BYTES / 3) * 4 + 1024).toBeLessThan(8 * MiB);
  });

  test("rejection vocabulary matches the shared corpus", () => {
    expect<readonly string[]>(PROTOTYPE_MEDIA_REJECTIONS).toEqual(cases.rejectionCodes);
  });

  describe("shared signature cases", () => {
    for (const item of cases.signatures) {
      test(item.name, () => {
        if (!isPrototypeMediaMimeType(item.mimeType)) {
          throw new Error(`fixture uses non-media type ${item.mimeType}`);
        }
        const head = Buffer.from(item.hex, "hex").subarray(
          0,
          PROTOTYPE_MEDIA_SIGNATURE_PROBE_BYTES,
        );
        expect(prototypeMediaSignatureMatches(item.mimeType, head)).toBe(item.matches);
      });
    }
  });

  describe("shared begin cases", () => {
    for (const item of cases.begins) {
      test(item.name, () => {
        expect<string | null>(prototypeMediaBeginProblem(item)?.code ?? null).toBe(item.problem);
      });
    }
  });

  test("rejects a fractional or unsafe size as empty", () => {
    const sha256 = "0".repeat(64);
    expect(
      prototypeMediaBeginProblem({ id: "a", mimeType: "video/mp4", size: 1.5, sha256 })?.code,
    ).toBe("empty");
  });
});
