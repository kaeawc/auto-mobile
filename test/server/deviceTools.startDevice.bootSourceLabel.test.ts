import { describe, expect, test } from "bun:test";
import { bootSourceLabel } from "../../src/server/deviceToolsStartDevice";

describe("bootSourceLabel", () => {
  test("a launch by this call is not labelled a cold boot (snapshot loads share the path)", () => {
    expect(bootSourceLabel("cold-boot")).toBe("started by this call");
    expect(bootSourceLabel("cold-boot")).not.toContain("cold");
  });

  test("an already running device is labelled as such", () => {
    expect(bootSourceLabel("booted")).toBe("already booted");
  });
});
