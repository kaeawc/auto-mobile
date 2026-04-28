import { describe, expect, test } from "bun:test";
import { resolveChecksum, resolveLatestVersion, RELEASE_CHECKSUM_REGISTRY } from "../../src/constants/release";

describe("release constants helpers", function() {
  test("resolveChecksum returns registry[0] for latest", function() {
    const expected = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("latest", "android")).toBe(expected.apkSha256);
    expect(resolveChecksum("latest", "ios")).toBe(expected.ipaSha256);
  });

  test("resolveChecksum is case-insensitive for latest", function() {
    const expected = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("LATEST", "android")).toBe(expected.apkSha256);
    expect(resolveChecksum(" latest ", "ios")).toBe(expected.ipaSha256);
  });

  test("resolveChecksum returns exact match for pinned version", function() {
    const entry = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum(entry.version, "android")).toBe(entry.apkSha256);
    expect(resolveChecksum(entry.version, "ios")).toBe(entry.ipaSha256);
  });

  test("resolveChecksum returns empty string for unknown version", function() {
    expect(resolveChecksum("99.99.99", "android")).toBe("");
    expect(resolveChecksum("99.99.99", "ios")).toBe("");
  });

  test("resolveChecksum returns empty string for empty input", function() {
    expect(resolveChecksum("", "android")).toBe("");
  });

  test("resolveLatestVersion returns first registry entry version", function() {
    expect(resolveLatestVersion()).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});
