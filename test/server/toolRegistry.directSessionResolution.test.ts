import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { BootedDevice } from "../../src/models";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/utils/directSessionDeviceRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DeviceOutsideBoundSessionError } from "../../src/daemon/deviceOutsideBoundSessionRefusal";
import { ActionableError } from "../../src/models/ActionableError";
import { DirectSessionNotActiveError } from "../../src/models/DirectSessionNotActiveError";
import { isTypedToolRefusal, shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { z } from "zod/v4";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

isolateToolRegistry();

// #5893 item 3: in direct mode (--no-proxy, DaemonState not initialized), a tool
// call that carries only a sessionUuid must recover its device+platform from the
// direct-session registry rather than falling through to
// ensureDeviceReady("either", undefined) — which is ambiguous when both
// platforms are connected.
describe("ToolRegistry direct-mode sessionUuid resolution (#5893)", () => {
  const android: BootedDevice = {
    name: "Pixel_9_API_36",
    deviceId: "emulator-5554",
    platform: "android",
  };
  const ios: BootedDevice = {
    name: "iPhone 17",
    deviceId: "E2F46BCE-4C97-4AA0-BD9D-544756FAB545",
    platform: "ios",
  };

  let fakeDeviceReadiness: FakeDeviceReadiness;
  let originalDeviceReadiness: ReturnType<
    typeof ToolRegistry.getCollaboratorsForTesting
  >["deviceReadiness"];
  let restorePipelineOverrides: (() => void) | undefined;
  let ran: string[];

  beforeEach(() => {
    // Direct mode: daemon must not be initialized.
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
    fakeDeviceReadiness = new FakeDeviceReadiness();
    ran = [];
    originalDeviceReadiness = ToolRegistry.getCollaboratorsForTesting().deviceReadiness;
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: fakeDeviceReadiness });
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      auditRunner: {
        async run(input) {
          ran.push(input.device.deviceId);
          return { success: true };
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });
  });

  afterEach(() => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: originalDeviceReadiness });
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
  });

  const registerTool = () => {
    ToolRegistry.registerDeviceAware(
      "directResolutionTool",
      "Tool used to observe direct-mode device resolution",
      z.object({
        platform: z.enum(["ios", "android"]).optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
    );
    const tool = ToolRegistry.getTool("directResolutionTool");
    expect(tool).toBeDefined();
    return tool!;
  };

  test("resolves device and narrows platform from the direct-session registry", async () => {
    fakeDeviceReadiness.setConnectedDevices([android, ios]);
    registerDirectSessionDevice("session-abc", android);
    const tool = registerTool();

    // Only sessionUuid — no platform, no deviceId.
    const response = await tool.handler({ sessionUuid: "session-abc" });
    expect(response).toEqual({ success: true });

    // Device was resolved from the direct session, and platform was narrowed
    // away from "either".
    expect(fakeDeviceReadiness.getLastEnsureDeviceReadyDeviceId()).toBe("emulator-5554");
    expect(fakeDeviceReadiness.getLastEnsureDeviceReadyPlatform()).toBe("android");
  });

  test("resolves an iOS direct session the same way", async () => {
    fakeDeviceReadiness.setConnectedDevices([android, ios]);
    registerDirectSessionDevice("session-ios", ios);
    const tool = registerTool();

    const response = await tool.handler({ sessionUuid: "session-ios" });
    expect(response).toEqual({ success: true });

    expect(fakeDeviceReadiness.getLastEnsureDeviceReadyDeviceId()).toBe(ios.deviceId);
    expect(fakeDeviceReadiness.getLastEnsureDeviceReadyPlatform()).toBe("ios");
  });

  const rotate = (args: Record<string, unknown>) => {
    registerInteractionTools({});
    return ToolRegistry.getTool("rotate")!.handler({ orientation: "landscape", ...args });
  };

  test("refuses a control tool's mismatched deviceId before readiness", async () => {
    fakeDeviceReadiness.setConnectedDevices([android, ios]);
    registerDirectSessionDevice("session-abc", android);
    await expect(
      rotate({ sessionUuid: "session-abc", deviceId: ios.deviceId }),
    ).rejects.toBeInstanceOf(DeviceOutsideBoundSessionError);
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
    expect(ran).toEqual([]);
  });

  test.each(["unknown", "cancelled", "replaced"] as const)(
    "refuses a %s session before readiness even with a fallback pin and explicit deviceId",
    async (state) => {
      fakeDeviceReadiness.setConnectedDevices([android]);
      fakeDeviceReadiness.setExplicitDevicePin(android);
      if (state !== "unknown") {
        registerDirectSessionDevice("session-stale", android);
        if (state === "cancelled") {
          unregisterDirectSession("session-stale");
        } else {
          registerDirectSessionDevice("session-new", android);
        }
      }
      const error = await rotate({ sessionUuid: "session-stale" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toBeInstanceOf(DirectSessionNotActiveError);
      expect(error).toMatchObject({
        code: "direct_session_not_active",
        retryable: false,
        nextAction: "acquire_new_session",
        sessionUuid: "session-stale",
        message: expect.stringContaining("getAndroid or getApple"),
      });
      expect(isTypedToolRefusal(error)).toBe(true);
      const result = shapeToolCallError(error, { toolName: "rotate", source: "MCP" });
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: "direct_session_not_active",
        sessionUuid: "session-stale",
        nextAction: "acquire_new_session",
        retryable: false,
      });
      await expect(
        rotate({ sessionUuid: "session-stale", deviceId: android.deviceId }),
      ).rejects.toBeInstanceOf(DirectSessionNotActiveError);
      expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
      expect(ran).toEqual([]);
    },
  );

  test.each([false, true])(
    "a registered session runs on its own device (explicit=%s)",
    async (explicit) => {
      fakeDeviceReadiness.setConnectedDevices([android]);
      registerDirectSessionDevice("session-abc", android);
      await rotate({
        sessionUuid: "session-abc",
        ...(explicit ? { deviceId: android.deviceId } : {}),
      });
      expect(ran).toEqual([android.deviceId]);
      expect(fakeDeviceReadiness.getLastEnsureDeviceReadyDeviceId()).toBe(android.deviceId);
    },
  );
});
