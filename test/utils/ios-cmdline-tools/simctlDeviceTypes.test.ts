import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimctlDeviceTypes } from "../../../src/utils/ios-cmdline-tools/simctlDeviceTypes";

const captured = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-simctl/list-devicetypes.json"),
  "utf8",
);

describe("parseSimctlDeviceTypes", () => {
  test("captured list devicetypes output parses", () => {
    const deviceTypes = parseSimctlDeviceTypes(captured);
    expect(deviceTypes).toHaveLength(4);
    expect(deviceTypes[0]).toMatchObject({
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      name: "iPhone 17 Pro",
      productFamily: "iPhone",
    });
  });

  test("rejects malformed output", () => {
    expect(() => parseSimctlDeviceTypes("not json")).toThrow();
    expect(() => parseSimctlDeviceTypes("null")).toThrow("does not contain a devicetypes array");
    expect(() => parseSimctlDeviceTypes("{}")).toThrow("does not contain a devicetypes array");
  });
});
