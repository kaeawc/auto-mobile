import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppleDeviceType } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  deviceTypeRuntimeBounds,
  evaluateRuntimeCompatibility,
} from "../../src/utils/ios-cmdline-tools/runtimeCompatibility";

const captured = (
  JSON.parse(
    readFileSync(join(import.meta.dir, "../fixtures/ios-simctl/list-devicetypes.json"), "utf8"),
  ) as { devicetypes: AppleDeviceType[] }
).devicetypes;

function captureOf(name: string): AppleDeviceType {
  const found = captured.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`fixture missing ${name}`);
  }
  return found;
}

function synthetic(overrides: Partial<AppleDeviceType>): AppleDeviceType {
  return {
    minRuntimeVersion: 0,
    maxRuntimeVersion: 0,
    bundlePath: "",
    name: "Synthetic",
    identifier: "synthetic",
    productFamily: "iPhone",
    ...overrides,
  };
}

describe("evaluateRuntimeCompatibility", () => {
  test("captured unbounded-maximum model: supported at and above the minimum, unsupported below", () => {
    const model = captureOf("iPhone 17 Pro");
    expect(deviceTypeRuntimeBounds(model)).toEqual({ minVersion: "26.0.0", maxVersion: null });
    expect(evaluateRuntimeCompatibility(model, "26.0").status).toBe("supported");
    expect(evaluateRuntimeCompatibility(model, "27.1").status).toBe("supported");
    expect(evaluateRuntimeCompatibility(model, "18.6").status).toBe("unsupported");
  });

  test("captured bounded model: both endpoints are inclusive", () => {
    const model = captureOf("iPhone 8");
    expect(deviceTypeRuntimeBounds(model)).toEqual({ minVersion: "11.0.0", maxVersion: "16.9.0" });
    expect(evaluateRuntimeCompatibility(model, "11.0").status).toBe("supported");
    expect(evaluateRuntimeCompatibility(model, "16.9").status).toBe("supported");
    expect(evaluateRuntimeCompatibility(model, "16.9.1").status).toBe("unsupported");
    expect(evaluateRuntimeCompatibility(model, "10.3").status).toBe("unsupported");
  });

  test("packed integers are used when version strings are absent", () => {
    const model = synthetic({ minRuntimeVersion: 1703936, maxRuntimeVersion: 0xffffffff });
    expect(deviceTypeRuntimeBounds(model)).toEqual({ minVersion: "26.0.0", maxVersion: null });
    expect(evaluateRuntimeCompatibility(model, "26.5").status).toBe("supported");
  });

  test("a string version wins over its packed counterpart", () => {
    const model = synthetic({
      minRuntimeVersion: 1703936,
      minRuntimeVersionString: "27.0",
      maxRuntimeVersion: 0xffffffff,
    });
    expect(evaluateRuntimeCompatibility(model, "26.5").status).toBe("unsupported");
  });

  test("missing range metadata is unknown, not unsupported", () => {
    const result = evaluateRuntimeCompatibility(synthetic({}), "26.5");
    expect(result.status).toBe("unknown");
    expect(result.bounds).toBeUndefined();
  });

  test("malformed or inverted bounds are unknown", () => {
    expect(
      evaluateRuntimeCompatibility(
        synthetic({ minRuntimeVersionString: "abc", maxRuntimeVersion: 0xffffffff }),
        "26.5",
      ).status,
    ).toBe("unknown");
    expect(
      evaluateRuntimeCompatibility(
        synthetic({ minRuntimeVersionString: "27.0", maxRuntimeVersionString: "26.0" }),
        "26.5",
      ).status,
    ).toBe("unknown");
  });

  test("a malformed runtime version is unknown but still reports the model bounds", () => {
    const result = evaluateRuntimeCompatibility(captureOf("iPhone 17 Pro"), "not-a-version");
    expect(result.status).toBe("unknown");
    expect(result.bounds).toEqual({ minVersion: "26.0.0", maxVersion: null });
  });
});
