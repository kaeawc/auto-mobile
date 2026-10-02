import { afterEach, describe, expect, test } from "bun:test";
import {
  setPostureSchema,
  setPostureHandler,
  setSetPostureFactory,
  resetSetPostureFactory,
} from "../../src/server/interactionTools";
import { setPostureResultSchema } from "../../src/server/toolOutputSchemas";
import { z } from "zod/v4";
import {
  HINGE_ANGLE_MIN_DEGREES,
  HINGE_ANGLE_MAX_DEGREES,
} from "../../src/features/device/SetPosture";
import type { BootedDevice } from "../../src/models";

describe("setPosture hinge angle contract", () => {
  afterEach(resetSetPostureFactory);
  test("schema bounds use the action's exported constants", () => {
    const json = z.toJSONSchema(setPostureSchema.shape.hingeAngle);
    expect(json.minimum).toBe(HINGE_ANGLE_MIN_DEGREES);
    expect(json.maximum).toBe(HINGE_ANGLE_MAX_DEGREES);
    expect(HINGE_ANGLE_MIN_DEGREES).toBe(0);
    expect(HINGE_ANGLE_MAX_DEGREES).toBe(180);
  });
  test.each([{ posture: "opened", hingeAngle: 90 }, {}])(
    "requires exactly one selector: %j",
    (args) => {
      expect(setPostureSchema.safeParse(args).success).toBe(false);
    },
  );
  test.each([0, 90, 180])("accepts hinge angle %s", (hingeAngle) => {
    expect(setPostureSchema.safeParse({ hingeAngle }).success).toBe(true);
  });
  test.each([-1, 181, NaN, Infinity, -Infinity])("rejects hinge angle %s", (hingeAngle) => {
    expect(setPostureSchema.safeParse({ hingeAngle }).success).toBe(false);
  });
  test("rejects presets with angles and retains strictness and device targeting", () => {
    expect(setPostureSchema.safeParse({ hingeAngle: 90, displayPreset: "phone" }).success).toBe(
      false,
    );
    expect(setPostureSchema.safeParse({ hingeAngle: 90, extra: true }).success).toBe(false);
    expect(setPostureSchema.safeParse({ hingeAngle: 90, deviceId: "emulator-5554" }).success).toBe(
      true,
    );
  });
  test("unknown posture is permitted only for an angle with a reason", () => {
    const result = {
      message: "Set hinge angle",
      posture: "unknown",
      display: { key: "inner", role: "inner", posture: "unknown", generation: 1 },
    };
    expect(
      setPostureResultSchema.safeParse({
        ...result,
        hingeAngle: 90,
        postureReason: "No committed state",
      }).success,
    ).toBe(true);
    expect(setPostureResultSchema.safeParse(result).success).toBe(false);
    expect(setPostureResultSchema.safeParse({ ...result, hingeAngle: 90 }).success).toBe(false);
  });
  test("handler forwards the angle and signal and describes the device read-back", async () => {
    const calls: unknown[] = [];
    setSetPostureFactory(() => ({
      execute: async () => {
        throw new Error("Unexpected posture request");
      },
      executeHingeAngle: async (angle, options) => {
        calls.push([angle, options]);
        return {
          hingeAngle: angle,
          observedHingeAngle: 89,
          posture: "half_opened",
          display: { key: "inner", role: "inner", posture: "half_opened", generation: 2 },
        };
      },
    }));
    const signal = new AbortController().signal;
    const device: BootedDevice = { name: "Fold", platform: "android", deviceId: "emulator-5554" };
    const response = await setPostureHandler(device, { hingeAngle: 90 }, undefined, signal);
    expect(calls).toEqual([[90, { displayPreset: undefined, signal }]]);
    expect(response.structuredContent).toMatchObject({
      message: "Set hinge angle to 90 degrees; device reports posture half_opened",
      hingeAngle: 90,
      observedHingeAngle: 89,
    });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });
});
