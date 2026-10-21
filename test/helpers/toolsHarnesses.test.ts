import { afterEach, describe, expect, test } from "bun:test";
import type { AppPermissionsFactory } from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createAppToolsHarness } from "./appToolsHarness";
import { createVideoRecordingToolsHarness } from "./videoRecordingToolsHarness";

describe("tool harnesses", () => {
  afterEach(() => ToolRegistry.clearTools());

  test("appToolsHarness.configure keeps a factory override intact", async () => {
    const harness = createAppToolsHarness();
    let built = 0;
    const factory: AppPermissionsFactory = () => {
      built += 1;
      return { setPermissions: async () => ({ success: true, changedCount: 0 }) as never };
    };
    harness.configure("appPermissionsFactory", factory);
    // A later family must not clobber it either.
    harness.configure("listApps", {});
    const device = { deviceId: "fake", platform: "android" } as never;
    await ToolRegistry.getTool("setAppPermissions")!.deviceAwareHandler!(device, {
      appId: "com.test",
      action: "grant",
      permissions: [],
    } as never);
    expect(built).toBe(1);
    harness.clear();
  });

  test("videoRecordingToolsHarness.clear unregisters the handler", () => {
    const harness = createVideoRecordingToolsHarness();
    harness.register();
    expect(ToolRegistry.getTool("videoRecording")).toBeDefined();
    harness.clear();
    expect(ToolRegistry.getTool("videoRecording")).toBeUndefined();
  });
});
