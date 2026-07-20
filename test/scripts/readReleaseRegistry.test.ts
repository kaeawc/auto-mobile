import { describe, expect, test } from "bun:test";
import { readReleaseRegistryField } from "../../scripts/read-release-registry";

const RELEASE_SOURCE = new URL("../../src/constants/release.ts", import.meta.url).pathname;

describe("readReleaseRegistryField", () => {
  test("reads the first tagged entry and the dedicated nightly entry through module exports", async () => {
    expect(await readReleaseRegistryField("version", RELEASE_SOURCE)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await readReleaseRegistryField("version", RELEASE_SOURCE, "nightly")).toBe("nightly");
  });

  test("returns an empty value for a missing scalar", async () => {
    expect(await readReleaseRegistryField("notAField", RELEASE_SOURCE)).toBe("");
  });
});
