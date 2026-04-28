import { describe, expect, test } from "bun:test";
import {
  resolveChecksum,
  resolveLatestVersion,
  RELEASE_CHECKSUM_REGISTRY,
  type ReleaseChecksumEntry,
} from "../../src/constants/release";

describe("resolveChecksum", function() {
  test("latest resolves to registry[0] (newest entry)", function() {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("latest", "android")).toBe(newest.apkSha256);
    expect(resolveChecksum("latest", "ios")).toBe(newest.ipaSha256);
  });

  test("latest is case-insensitive and trims whitespace", function() {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("LATEST", "android")).toBe(newest.apkSha256);
    expect(resolveChecksum(" latest ", "ios")).toBe(newest.ipaSha256);
  });

  test("pinned 0.0.18 resolves to its specific checksums", function() {
    expect(resolveChecksum("0.0.18", "android")).toBe("fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834");
    expect(resolveChecksum("0.0.18", "ios")).toBe("2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39");
  });

  test("pinned 0.0.17 resolves to its specific checksums, not latest", function() {
    expect(resolveChecksum("0.0.17", "android")).toBe("916033440931666644474f227c8e39d13d9c80c3515e4292cc5581fd5bd4cc2f");
    expect(resolveChecksum("0.0.17", "ios")).toBe("e4dcf064d024f2371b8fd79281000e2d49751ef95b8817d1494d685aeda746ac");
  });

  test("latest and pinned 0.0.17 return different checksums", function() {
    expect(resolveChecksum("latest", "android")).not.toBe(resolveChecksum("0.0.17", "android"));
    expect(resolveChecksum("latest", "ios")).not.toBe(resolveChecksum("0.0.17", "ios"));
  });

  test("pinned version not in registry returns empty string", function() {
    expect(resolveChecksum("99.99.99", "android")).toBe("");
    expect(resolveChecksum("99.99.99", "ios")).toBe("");
  });

  test("empty version returns empty string", function() {
    expect(resolveChecksum("", "android")).toBe("");
  });

  test("empty registry returns empty string", function() {
    const empty: ReleaseChecksumEntry[] = [];
    expect(resolveChecksum("latest", "android", empty)).toBe("");
    expect(resolveChecksum("0.0.18", "ios", empty)).toBe("");
  });

  test("multi-entry registry resolves each version independently", function() {
    const registry: ReleaseChecksumEntry[] = [
      { version: "0.0.20", apkSha256: "apk20", ipaSha256: "ipa20" },
      { version: "0.0.19", apkSha256: "apk19", ipaSha256: "ipa19" },
      { version: "0.0.18", apkSha256: "apk18", ipaSha256: "ipa18" },
    ];
    expect(resolveChecksum("latest", "android", registry)).toBe("apk20");
    expect(resolveChecksum("0.0.19", "android", registry)).toBe("apk19");
    expect(resolveChecksum("0.0.18", "ios", registry)).toBe("ipa18");
    expect(resolveChecksum("0.0.17", "android", registry)).toBe("");
  });
});

describe("resolveLatestVersion", function() {
  test("returns first registry entry version", function() {
    expect(resolveLatestVersion()).toBe("0.0.18");
  });
});
