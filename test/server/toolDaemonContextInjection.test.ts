import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonContext } from "../../src/daemon/daemonContext";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { BiometricAuth } from "../../src/features/action/BiometricAuth";
import { TalkBackToggle } from "../../src/features/accessibility/TalkBackToggle";
import { DeviceState } from "../../src/features/utility/DeviceState";
import type { BootedDevice } from "../../src/models";
import { registerAccessibilityTools } from "../../src/server/accessibilityTools";
import { registerBiometricTools } from "../../src/server/biometricTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const ANDROID = { name: "a", deviceId: "emulator-5554", platform: "android" } as BootedDevice;
const IOS = { name: "i", deviceId: "sim-1", platform: "ios" } as BootedDevice;

function deviceAwareHandler(name: string) {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find((t) => t.name === name);
  if (!tool?.deviceAwareHandler) {
    throw new Error(`${name} tool not registered`);
  }
  return tool.deviceAwareHandler;
}

isolateToolRegistry();

describe("tool registration daemon context injection", () => {
  let manager: SessionManager;
  let daemon: DaemonContext;
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    ToolRegistry.clearTools();
    // The injected context is the only source of the SessionManager: the singleton stays uninitialized.
    DaemonState.getInstance().reset();
    manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
      keepScreenAwakeRestorer: () => ({ restore: async () => ({ status: "restored" as const }) }),
      biometricEnrollmentRestorer: () => ({ restore: async () => {} }),
    });
    daemon = {
      renderedDisplaySessions: () => undefined,
      sessionManager: () => manager,
      devicePool: () => undefined,
    };
  });

  afterEach(() => {
    spies
      .splice(0)
      .reverse()
      .forEach((spy) => spy.mockRestore());
    manager.stopCleanupTimer();
    ToolRegistry.clearTools();
  });

  test("accessibility records the previous screen-reader state in the injected session manager", async () => {
    spies.push(
      spyOn(TalkBackToggle.prototype, "toggle").mockImplementation(async (enabled, options) => {
        await options?.beforeChange?.(false);
        return { supported: true, applied: true, currentState: enabled };
      }),
    );
    registerAccessibilityTools(daemon);
    await manager.createSession("a11y-session", ANDROID.deviceId, "android");

    await deviceAwareHandler("accessibility")(ANDROID, {
      talkback: true,
      sessionUuid: "a11y-session",
    });

    expect(manager.getScreenReader("a11y-session")).toEqual({
      platform: "android",
      previousEnabled: false,
    });
  });

  test("biometricAuth captures enrollment in the injected session manager", async () => {
    spies.push(
      spyOn(DeviceState.prototype, "getBiometricEnrollmentState").mockResolvedValue({
        supported: true,
        enrollment: "not_enrolled",
      } as Awaited<ReturnType<DeviceState["getBiometricEnrollmentState"]>>),
      spyOn(BiometricAuth.prototype, "execute").mockResolvedValue({
        success: true,
        message: "ok",
      } as Awaited<ReturnType<BiometricAuth["execute"]>>),
    );
    registerBiometricTools(daemon);
    await manager.createSession("bio-session", IOS.deviceId, "ios");

    await deviceAwareHandler("biometricAuth")(IOS, {
      action: "enroll",
      sessionUuid: "bio-session",
    });

    expect(manager.getBiometricEnrollment("bio-session")).toEqual({
      initialEnrollment: "not_enrolled",
    });
  });
});
