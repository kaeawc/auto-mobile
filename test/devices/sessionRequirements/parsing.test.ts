import { describe, expect, test } from "bun:test";
import {
  parseNumericVersion,
  parseSessionDeviceRequirement,
} from "../../../src/devices/sessionRequirements";
import { unwrap, unwrapError } from "./fixtures";

describe("session requirement parsing", () => {
  test("accepts only consumer device predicates", () => {
    const parsed = unwrap(
      parseSessionDeviceRequirement({
        schemaVersion: 1,
        platform: "ios",
        hardware: {
          kind: "exact-model",
          model: { namespace: "product-model", value: "iPhone18,1" },
        },
        os: { kind: "major", major: 27 },
      }),
    );

    expect(parsed).toEqual({
      schemaVersion: 1,
      platform: "ios",
      hardware: {
        kind: "exact-model",
        model: { namespace: "product-model", value: "iPhone18,1" },
      },
      os: { kind: "major", major: 27 },
    });
    for (const forbidden of ["slot", "lane", "capacity", "priorDevice"]) {
      const invalid = parseSessionDeviceRequirement({
        ...parsed,
        [forbidden]: "caller-owned",
      });
      expect(unwrapError(invalid).code).toBe("invalid_request");
    }
  });

  test.each([
    { kind: "exact-model", model: { namespace: "alias", value: "pixel" } },
    {
      kind: "model-type",
      modelType: { family: "iphone", variant: "pro" },
    },
    { kind: "archetype", archetype: "duo" },
    { kind: "archetype", archetype: "foldable" },
  ])("rejects unsupported Android hardware selector %#", (hardware) => {
    const parsed = parseSessionDeviceRequirement({
      schemaVersion: 1,
      platform: "android",
      hardware,
      os: { kind: "omitted" },
    });

    expect(unwrapError(parsed).code).toBe("invalid_request");
  });

  test.each(["27L", "27-QPR1", "API-35", " 27.0", "27.0 ", "27..1", "-27", "0"])(
    "rejects ambiguous or malformed release %s",
    (version) => {
      expect(unwrapError(parseNumericVersion(version)).code).toBe("invalid_request");
    },
  );

  test("validates while preserving original numeric spelling", () => {
    const exact = unwrap(
      parseSessionDeviceRequirement({
        schemaVersion: 1,
        platform: "ios",
        hardware: { kind: "omitted" },
        os: { kind: "exact", version: "027.0.0" },
      }),
    );
    const minimum = unwrap(
      parseSessionDeviceRequirement({
        schemaVersion: 1,
        platform: "ios",
        hardware: { kind: "omitted" },
        os: { kind: "minimum", version: "27.0.0" },
      }),
    );

    expect(exact.os).toEqual({ kind: "exact", version: "027.0.0" });
    expect(minimum.os).toEqual({ kind: "minimum", version: "27.0.0" });
  });

  test.each([
    { family: "iphone", variant: "pro" },
    { family: "iphone", variant: "pro-max" },
    { family: "iphone", variant: "air" },
    { family: "ipad", variant: "air", sizeInches: "11" },
    { family: "ipad", variant: "air", sizeInches: "13" },
    { family: "duo", variant: "duo" },
  ])("accepts structured iOS model type %#", (modelType) => {
    const parsed = parseSessionDeviceRequirement({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "model-type", modelType },
      os: { kind: "omitted" },
    });

    expect(parsed.ok).toBeTrue();
  });
});
