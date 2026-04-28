import { describe, expect, test } from "bun:test";
import {
  resolveChecksum,
  resolveLatestVersion,
  RELEASE_CHECKSUM_REGISTRY,
  type ReleaseChecksumEntry,
} from "../../src/constants/release";

const multiEntryRegistry: ReleaseChecksumEntry[] = [
  { version: "0.0.19", apkSha256: "aaa111", ipaSha256: "bbb111" },
  { version: "0.0.18", apkSha256: "aaa222", ipaSha256: "bbb222" },
  { version: "0.0.17", apkSha256: "aaa333", ipaSha256: "bbb333" },
];

describe("resolveChecksum", function() {
  test("latest resolves to registry[0]", function() {
    const expected = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("latest", "android")).toBe(expected.apkSha256);
    expect(resolveChecksum("latest", "ios")).toBe(expected.ipaSha256);
  });

  test("latest is case-insensitive and trims whitespace", function() {
    const expected = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("LATEST", "android")).toBe(expected.apkSha256);
    expect(resolveChecksum(" latest ", "ios")).toBe(expected.ipaSha256);
  });

  test("latest resolves to newest entry in multi-entry registry", function() {
    expect(resolveChecksum("latest", "android", multiEntryRegistry)).toBe("aaa111");
    expect(resolveChecksum("latest", "ios", multiEntryRegistry)).toBe("bbb111");
  });

  test("pinned version resolves to its specific entry, not latest", function() {
    expect(resolveChecksum("0.0.18", "android", multiEntryRegistry)).toBe("aaa222");
    expect(resolveChecksum("0.0.18", "ios", multiEntryRegistry)).toBe("bbb222");
    expect(resolveChecksum("0.0.17", "android", multiEntryRegistry)).toBe("aaa333");
    expect(resolveChecksum("0.0.17", "ios", multiEntryRegistry)).toBe("bbb333");
  });

  test("pinned version returns empty string when not in registry", function() {
    expect(resolveChecksum("99.99.99", "android", multiEntryRegistry)).toBe("");
    expect(resolveChecksum("99.99.99", "ios", multiEntryRegistry)).toBe("");
  });

  test("empty version returns empty string", function() {
    expect(resolveChecksum("", "android")).toBe("");
  });

  test("empty registry returns empty string", function() {
    expect(resolveChecksum("latest", "android", [])).toBe("");
    expect(resolveChecksum("0.0.18", "ios", [])).toBe("");
  });
});

describe("resolveLatestVersion", function() {
  test("returns first registry entry version", function() {
    expect(resolveLatestVersion()).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});
