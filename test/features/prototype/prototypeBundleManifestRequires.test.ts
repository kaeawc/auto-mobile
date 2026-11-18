import { describe, expect, test } from "bun:test";
import { parseBundleManifest } from "../../../src/features/prototype/bundle/bundleManifest";
import { BundleFailure } from "../../../src/features/prototype/bundle/bundleContract";

function manifest(requires: unknown): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      bundleFormatVersion: 1,
      specSha256: "0".repeat(64),
      assets: [],
      fonts: [],
      requires,
    }),
  );
}

function failureCode(requires: unknown): string | undefined {
  try {
    parseBundleManifest(manifest(requires));
  } catch (error) {
    if (error instanceof BundleFailure) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe("bundle manifest requires", () => {
  test("accepts camelCase generated capability names (#18598)", () => {
    const names = ["prototype_platform_deviceStatus_v1", "prototype_platform_secureStorage_v1"];
    expect(parseBundleManifest(manifest(names)).requires).toEqual(names);
  });

  test("rejects invalid, unsorted and duplicate names", () => {
    for (const requires of [
      ["SecureStorage"],
      ["prototype_platform_secure-storage_v1"],
      ["prototype_platform_secureStorage_v1", "prototype_platform_deviceStatus_v1"],
      ["prototype_platform_secureStorage_v1", "prototype_platform_secureStorage_v1"],
    ]) {
      expect(failureCode(requires)).toBe("requires_invalid");
    }
  });
});
