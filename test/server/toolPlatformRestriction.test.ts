import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../../src/models";
import { invokeRecordedInternalTool } from "../../src/server/deviceMutationDispatch";
import { invokeResolvedDeviceHandler } from "../../src/server/pipeline/deviceCallDispatch";
import {
  assertDeviceInToolPlatforms,
  type ToolPlatforms,
} from "../../src/server/toolPlatformRestriction";
import type { RegisteredTool } from "../../src/server/toolRegistryTypes";

const PHONE: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const IPHONE: BootedDevice = { deviceId: "IPHONE-UDID", platform: "ios", name: "iPhone" };
const WATCH: BootedDevice = { deviceId: "WATCH-UDID", platform: "watchos", name: "Watch" };
const TV: BootedDevice = { deviceId: "TV-UDID", platform: "tvos", name: "Apple TV" };

describe("assertDeviceInToolPlatforms (#18721)", () => {
  test("an unrestricted tool admits every device", () => {
    expect(() => assertDeviceInToolPlatforms("tapOn", undefined, IPHONE)).not.toThrow();
  });

  test("an Android-only tool admits Android and refuses iOS with one actionable message", () => {
    expect(() => assertDeviceInToolPlatforms("captureTrace", ["android"], PHONE)).not.toThrow();
    expect(() => assertDeviceInToolPlatforms("captureTrace", ["android"], IPHONE)).toThrow(
      new ActionableError(
        "captureTrace is only supported on Android; IPHONE-UDID is iOS. Target a device running Android instead.",
      ),
    );
  });

  test("a multi-platform restriction names every platform it admits", () => {
    const platforms: ToolPlatforms = ["android", "tvos"];
    expect(() => assertDeviceInToolPlatforms("focusNavigate", platforms, TV)).not.toThrow();
    expect(() => assertDeviceInToolPlatforms("focusNavigate", platforms, IPHONE)).toThrow(
      "focusNavigate is only supported on Android and tvOS; IPHONE-UDID is iOS.",
    );
  });
});

describe("the device dispatch enforces the restriction before the handler (#18721)", () => {
  const dispatch = (device: BootedDevice, platforms: ToolPlatforms | undefined) => {
    const calls: string[] = [];
    const run = invokeResolvedDeviceHandler({
      target: {
        args: {},
        baseSessionUuid: undefined,
        device,
        internalCall: false,
        sessionUuid: undefined,
        shouldResolveDevice: true,
      },
      name: "captureTrace",
      args: {},
      handler: async (target) => {
        calls.push(target.deviceId);
        return { content: [] };
      },
      platforms,
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      navigationRecorder: { record: () => undefined },
      mutationRecording: { beforeToolCall: async () => undefined },
      isResponseFailure: () => false,
    });
    return { run, calls };
  };

  test("an iOS device never reaches an Android-only handler", async () => {
    const { run, calls } = dispatch(IPHONE, ["android"]);
    await expect(run).rejects.toThrow("captureTrace is only supported on Android");
    expect(calls).toEqual([]);
  });

  test("a watch hears the tool's own platforms, not the Apple platform gate", async () => {
    const { run, calls } = dispatch(WATCH, ["android"]);
    await expect(run).rejects.toThrow(
      "captureTrace is only supported on Android; WATCH-UDID is watchOS.",
    );
    expect(calls).toEqual([]);
  });

  test("an Android device runs the handler", async () => {
    const { run, calls } = dispatch(PHONE, ["android"]);
    await run;
    expect(calls).toEqual(["emulator-5554"]);
  });
});

describe("pinned internal dispatch enforces the restriction too (#18721)", () => {
  const pinnedTool = (calls: string[]): RegisteredTool => ({
    name: "mediaSession",
    description: "media",
    schema: z.object({}),
    handler: async () => ({ content: [] }),
    deviceAwareHandler: async (device) => {
      calls.push(device.deviceId);
      return { content: [] };
    },
    defaultEnabled: true,
    defaultDeclared: true,
    requiresDevice: true,
    platforms: ["android"],
  });
  const recording = { beforeToolCall: async () => undefined };

  test("a plan step pinned to an iOS device never reaches an Android-only handler", async () => {
    const calls: string[] = [];
    await expect(
      (async () =>
        invokeRecordedInternalTool(pinnedTool(calls), {}, undefined, {
          targetDevice: IPHONE,
          mutationRecording: recording,
        }))(),
    ).rejects.toThrow("mediaSession is only supported on Android; IPHONE-UDID is iOS.");
    expect(calls).toEqual([]);
  });

  test("a step pinned to an Android device runs the handler", async () => {
    const calls: string[] = [];
    await invokeRecordedInternalTool(pinnedTool(calls), {}, undefined, {
      targetDevice: PHONE,
      mutationRecording: recording,
    });
    expect(calls).toEqual(["emulator-5554"]);
  });
});
