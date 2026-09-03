import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { BootedDevice } from "../../src/models";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { z } from "zod/v4";

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

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;

  beforeEach(() => {
    // Direct mode: daemon must not be initialized.
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
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
    fakeDeviceSessionManager.setConnectedDevices([android, ios]);
    registerDirectSessionDevice("session-abc", android);
    const tool = registerTool();

    // Only sessionUuid — no platform, no deviceId.
    const response = await tool.handler({ sessionUuid: "session-abc" });
    expect(response).toEqual({ success: true });

    // Device was resolved from the direct session, and platform was narrowed
    // away from "either".
    expect(fakeDeviceSessionManager.getLastEnsureDeviceReadyDeviceId()).toBe("emulator-5554");
    expect(fakeDeviceSessionManager.getLastEnsureDeviceReadyPlatform()).toBe("android");
  });

  test("resolves an iOS direct session the same way", async () => {
    fakeDeviceSessionManager.setConnectedDevices([android, ios]);
    registerDirectSessionDevice("session-ios", ios);
    const tool = registerTool();

    const response = await tool.handler({ sessionUuid: "session-ios" });
    expect(response).toEqual({ success: true });

    expect(fakeDeviceSessionManager.getLastEnsureDeviceReadyDeviceId()).toBe(ios.deviceId);
    expect(fakeDeviceSessionManager.getLastEnsureDeviceReadyPlatform()).toBe("ios");
  });

  test("rejects an explicit deviceId that differs from the direct session's device", async () => {
    fakeDeviceSessionManager.setConnectedDevices([android, ios]);
    registerDirectSessionDevice("session-abc", android);
    const tool = registerTool();

    await expect(
      tool.handler({ sessionUuid: "session-abc", deviceId: ios.deviceId }),
    ).rejects.toThrow(`Session session-abc is bound to ${android.deviceId}, not ${ios.deviceId}.`);

    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("rejects an unknown sessionUuid before resolving a device", async () => {
    fakeDeviceSessionManager.setConnectedDevices([android]);
    const tool = registerTool();

    await expect(tool.handler({ sessionUuid: "session-unknown" })).rejects.toThrow(
      "Unknown session UUID",
    );

    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
    expect(fakeDeviceSessionManager.getLastEnsureDeviceReadyDeviceId()).toBeUndefined();
  });
});
