import { afterEach, describe, expect, test } from "bun:test";
import {
  type InteractionToolDependencies,
  setPostureSchema,
  setPostureHandler,
} from "../../src/server/interactionTools";
import { setPostureResultSchema } from "../../src/server/toolOutputSchemas";
import { z } from "zod/v4";
import {
  HINGE_ANGLE_MIN_DEGREES,
  HINGE_ANGLE_MAX_DEGREES,
} from "../../src/features/device/SetPosture";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_TOOL_PARAM_NAMES,
} from "../../src/daemon/wire/constants";

const interactionDeps: InteractionToolDependencies = {};
describe("setPosture hinge angle contract", () => {
  afterEach(() => {
    delete interactionDeps.setPostureFactory;
  });
  const device: BootedDevice = { name: "Fold", platform: "android", deviceId: "emulator-5554" };
  const serverMetadata = {
    [INTERNAL_EXECUTION_ID_PARAM]: "exec",
    [INTERNAL_EXECUTION_START_TIME_PARAM]: 0,
    [INTERNAL_MCP_SESSION_PARAM]: "session",
    [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 10_000,
    [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 10_000,
  };
  test.each([
    { selector: "posture", metadata: serverMetadata },
    { selector: "hingeAngle", metadata: serverMetadata },
    {
      selector: "posture",
      metadata: Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true])),
    },
    {
      selector: "hingeAngle",
      metadata: Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true])),
    },
  ])("handler accepts injected metadata: %j", async ({ selector, metadata }) => {
    const calls: unknown[] = [];
    const signal = new AbortController().signal;
    const result = {
      posture: "opened" as const,
      display: { key: "inner", role: "inner" as const, posture: "opened" as const, generation: 1 },
    };
    interactionDeps.setPostureFactory = (receivedDevice) => {
      expect(receivedDevice).toBe(device);
      return {
        execute: async (...args) => {
          calls.push(args);
          return result;
        },
        executeHingeAngle: async (...args) => {
          calls.push(args);
          return { ...result, hingeAngle: args[0] };
        },
      };
    };
    const postureArgs = Object.freeze({
      posture: "opened" as const,
      displayPreset: "tablet" as const,
      ...metadata,
    });
    const angleArgs = Object.freeze({ hingeAngle: 90, ...metadata });
    const args = selector === "posture" ? postureArgs : angleArgs;
    await setPostureHandler(device, args, undefined, signal, interactionDeps);
    expect(calls).toEqual(
      selector === "posture"
        ? [["opened", "tablet", signal]]
        : [[90, { displayPreset: undefined, signal }]],
    );
    expect(args).toMatchObject(metadata);
  });
  test.each([{}, { posture: "opened" as const, hingeAngle: 90 }])(
    "handler rejects neither/both with an actionable message: %j",
    async (args) => {
      let created = false;
      interactionDeps.setPostureFactory = () => {
        created = true;
        throw new Error("Unexpected action");
      };
      const promise = setPostureHandler(
        device,
        { ...args, ...serverMetadata },
        undefined,
        undefined,
        interactionDeps,
      );
      await expect(promise).rejects.toBeInstanceOf(ActionableError);
      await expect(promise).rejects.toMatchObject({
        message: "Specify exactly one of posture or hingeAngle.",
      });
      expect(created).toBe(false);
    },
  );
  test("handler rejects displayPreset with hingeAngle before creating the action", async () => {
    interactionDeps.setPostureFactory = () => {
      throw new Error("Unexpected action");
    };
    const promise = setPostureHandler(
      device,
      {
        hingeAngle: 90,
        displayPreset: "phone",
        ...serverMetadata,
      },
      undefined,
      undefined,
      interactionDeps,
    );
    await expect(promise).rejects.toBeInstanceOf(ActionableError);
    await expect(promise).rejects.toMatchObject({
      message: "displayPreset requires posture and cannot be combined with hingeAngle.",
    });
  });
  test("handler preserves an actionable device error without wrapping it again", async () => {
    const error = new ActionableError("Unsupported posture on this device.");
    interactionDeps.setPostureFactory = () => ({
      execute: async () => {
        throw error;
      },
      executeHingeAngle: async () => {
        throw error;
      },
    });
    await expect(
      setPostureHandler(
        device,
        { posture: "opened", ...serverMetadata },
        undefined,
        undefined,
        interactionDeps,
      ),
    ).rejects.toBe(error);
  });
  test("schema omits and strictly rejects obsolete observation controls", () => {
    const json = z.toJSONSchema(setPostureSchema);
    expect(json.properties).not.toHaveProperty("raw");
    expect(json.properties).not.toHaveProperty("project");
    expect(setPostureSchema.parse({ posture: "opened", displayPreset: "tablet" })).toMatchObject({
      posture: "opened",
      displayPreset: "tablet",
    });
    const parsed = setPostureSchema.safeParse({ posture: "opened", raw: true, project: "full" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toMatchObject([
        {
          code: "unrecognized_keys",
          keys: ["raw", "project"],
          message: 'Unrecognized keys: "raw", "project"',
        },
      ]);
    }
  });
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
    interactionDeps.setPostureFactory = () => ({
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
    });
    const signal = new AbortController().signal;
    const device: BootedDevice = { name: "Fold", platform: "android", deviceId: "emulator-5554" };
    const response = await setPostureHandler(
      device,
      { hingeAngle: 90 },
      undefined,
      signal,
      interactionDeps,
    );
    expect(calls).toEqual([[90, { displayPreset: undefined, signal }]]);
    expect(response.structuredContent).toMatchObject({
      message: "Set hinge angle to 90 degrees; device reports posture half_opened",
      hingeAngle: 90,
      observedHingeAngle: 89,
    });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });
  test.each([180, undefined])(
    "handler describes an unverified angle %s as requested",
    async (actual) => {
      interactionDeps.setPostureFactory = () => ({
        execute: async () => {
          throw new Error("Unexpected posture request");
        },
        executeHingeAngle: async () => ({
          hingeAngle: 120,
          ...(actual !== undefined ? { observedHingeAngle: actual } : {}),
          warnings: [
            actual === undefined
              ? "Could not verify hinge angle: KO: unknown sensor."
              : "Hinge angle read-back mismatch: requested 120 degrees but the emulator reports 180 degrees.",
          ],
          posture: "opened",
          display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
        }),
      });
      const response = await setPostureHandler(
        device,
        { hingeAngle: 120 },
        undefined,
        undefined,
        interactionDeps,
      );
      expect(response.structuredContent).toMatchObject({
        message:
          actual === undefined
            ? "Requested hinge angle 120 degrees; the resulting angle could not be verified (posture opened)"
            : "Requested hinge angle 120 degrees; the device reports 180 degrees (posture opened)",
      });
    },
  );
});
