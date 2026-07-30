import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultAuditRunner,
  DefaultPlanLifecycleManager,
  type AuditRunnerInput,
  type PlanLifecycleInput,
} from "../../src/server/toolRegistry";
import type { AppCleanupConfig, AppCleanupService } from "../../src/server/AppCleanupService";
import type { BootedDevice } from "../../src/models";
import type { SessionBindingReleaseHandler } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { DevicePool } from "../../src/daemon/devicePool";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeLogger } from "../fakes/FakeLogger";

// Deterministic fake for the injected server-side session-binding teardown seam
// (issue #4611 Gap D). Records every released session UUID afterExecution reports
// so the plan-release path can be asserted without a live MCP transport.
class FakeSessionBindingReleaseHandler implements SessionBindingReleaseHandler {
  released: string[] = [];

  onSessionReleased(sessionUuid: string): void {
    this.released.push(sessionUuid);
  }
}

// Direct, fast unit coverage for the two ToolRegistry pipeline collaborators
// called out in issue #3208. Both reach module-level singletons, so each test
// controls exactly the seam it exercises and restores it in a finally/afterEach.
// No real devices, daemon sessions, or wall-clock sleeps.

const androidDevice: BootedDevice = {
  name: "Pixel",
  deviceId: "emulator-5554",
  platform: "android",
};

const iosDevice: BootedDevice = {
  name: "iPhone",
  deviceId: "sim-1",
  platform: "ios",
};

describe("DefaultAuditRunner", () => {
  const originalCreate = defaultAdbClientFactory.create;
  let originalAuditEnabled: boolean;

  beforeEach(() => {
    originalAuditEnabled = serverConfig.isMemPerfAuditEnabled();
  });

  afterEach(() => {
    (defaultAdbClientFactory as { create: typeof originalCreate }).create = originalCreate;
    serverConfig.setMemPerfAuditMode(originalAuditEnabled);
  });

  const makeInput = (
    device: BootedDevice,
    handler: AuditRunnerInput["handler"]
  ): AuditRunnerInput => ({
    name: "tapOn",
    args: { x: 1, y: 2 },
    device,
    handler,
  });

  test("passes through to the handler when the mem-perf audit is disabled", async () => {
    serverConfig.setMemPerfAuditMode(false);
    let adbCreated = false;
    (defaultAdbClientFactory as { create: typeof originalCreate }).create = () => {
      adbCreated = true;
      return {} as ReturnType<typeof originalCreate>;
    };

    let handlerArgs: unknown;
    const runner = new DefaultAuditRunner();
    const result = await runner.run(
      makeInput(androidDevice, async (device, args) => {
        handlerArgs = { device, args };
        return { success: true, sentinel: "direct" };
      })
    );

    expect(result).toEqual({ success: true, sentinel: "direct" });
    expect(handlerArgs).toEqual({ device: androidDevice, args: { x: 1, y: 2 } });
    // No foreground-package lookup should be attempted on the pass-through path.
    expect(adbCreated).toBe(false);
  });

  test("passes through to the handler for non-android devices even when audit is enabled", async () => {
    serverConfig.setMemPerfAuditMode(true);
    let adbCreated = false;
    (defaultAdbClientFactory as { create: typeof originalCreate }).create = () => {
      adbCreated = true;
      return {} as ReturnType<typeof originalCreate>;
    };

    const runner = new DefaultAuditRunner();
    const result = await runner.run(
      makeInput(iosDevice, async () => ({ success: true, sentinel: "ios" }))
    );

    expect(result).toEqual({ success: true, sentinel: "ios" });
    expect(adbCreated).toBe(false);
  });

  test("looks up the foreground package via adb and skips the audit when none is focused", async () => {
    serverConfig.setMemPerfAuditMode(true);
    let receivedCommand: string | undefined;
    (defaultAdbClientFactory as { create: typeof originalCreate }).create = ((device?: BootedDevice) => {
      expect(device).toBe(androidDevice);
      return {
        async executeCommand(command: string) {
          receivedCommand = command;
          // No mCurrentFocus line -> regex miss -> null package.
          return { stdout: "no focus here", stderr: "", exitCode: 0 };
        },
      } as unknown as ReturnType<typeof originalCreate>;
    }) as typeof originalCreate;

    const log = new FakeLogger();
    let handlerCalled = false;
    const runner = new DefaultAuditRunner(log);
    const result = await runner.run(
      makeInput(androidDevice, async () => {
        handlerCalled = true;
        return { success: true, sentinel: "no-package" };
      })
    );

    expect(receivedCommand).toContain("dumpsys window");
    expect(receivedCommand).toContain("mCurrentFocus");
    expect(handlerCalled).toBe(true);
    expect(result).toEqual({ success: true, sentinel: "no-package" });
    expect(log.at("warn")).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("skipping memory audit"),
    }));
  });

  test("swallows adb failures during foreground lookup and still runs the handler", async () => {
    serverConfig.setMemPerfAuditMode(true);
    (defaultAdbClientFactory as { create: typeof originalCreate }).create = (() => ({
      async executeCommand() {
        throw new Error("adb offline");
      },
    })) as unknown as typeof originalCreate;

    const log = new FakeLogger();
    const runner = new DefaultAuditRunner(log);
    const result = await runner.run(
      makeInput(androidDevice, async () => ({ success: true, sentinel: "adb-error" }))
    );

    expect(result).toEqual({ success: true, sentinel: "adb-error" });
    expect(log.at("warn")).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("Failed to get foreground package name"),
    }));
  });
});

class FakeAppCleanupService implements AppCleanupService {
  calls: Array<{ device: BootedDevice; config: AppCleanupConfig }> = [];

  async cleanup(device: BootedDevice, config: AppCleanupConfig): Promise<void> {
    this.calls.push({ device, config });
  }
}

describe("DefaultPlanLifecycleManager", () => {
  afterEach(() => {
    DaemonState.getInstance().reset();
  });

  const makeInput = (
    overrides: Partial<PlanLifecycleInput> & { cleanupService: AppCleanupService }
  ): PlanLifecycleInput => ({
    name: "executePlan",
    args: {},
    baseSessionUuid: undefined,
    device: androidDevice,
    sessionUuid: undefined,
    shouldResolveDevice: true,
    ...overrides,
  });

  test("cleans up the plan app when executePlan declares a cleanupAppId", async () => {
    const cleanupService = new FakeAppCleanupService();
    const manager = new DefaultPlanLifecycleManager();

    await manager.afterExecution(
      makeInput({
        cleanupService,
        args: { cleanupAppId: "com.example.app", cleanupClearAppData: true },
      })
    );

    expect(cleanupService.calls).toEqual([
      {
        device: androidDevice,
        config: { appId: "com.example.app", clearAppData: true },
      },
    ]);
  });

  test("does not clean up when no cleanupAppId is present", async () => {
    const cleanupService = new FakeAppCleanupService();
    const manager = new DefaultPlanLifecycleManager();

    await manager.afterExecution(makeInput({ cleanupService, args: {} }));

    expect(cleanupService.calls).toEqual([]);
  });

  test("does not clean up for tools other than executePlan", async () => {
    const cleanupService = new FakeAppCleanupService();
    const manager = new DefaultPlanLifecycleManager();

    await manager.afterExecution(
      makeInput({
        cleanupService,
        name: "tapOn",
        args: { cleanupAppId: "com.example.app" },
      })
    );

    expect(cleanupService.calls).toEqual([]);
  });

  test("does not clean up when there is no resolved device", async () => {
    const cleanupService = new FakeAppCleanupService();
    const manager = new DefaultPlanLifecycleManager();

    await manager.afterExecution(
      makeInput({
        cleanupService,
        device: undefined,
        args: { cleanupAppId: "com.example.app" },
      })
    );

    expect(cleanupService.calls).toEqual([]);
  });

  test("skips auto-release when the daemon is not initialized", async () => {
    // Guard: the release path is gated on DaemonState.isInitialized(). With no
    // daemon it must be a no-op (never touching SessionManager/DevicePool), so
    // afterExecution resolves cleanly even with a session present.
    DaemonState.getInstance().reset();
    expect(DaemonState.getInstance().isInitialized()).toBe(false);

    const cleanupService = new FakeAppCleanupService();
    const manager = new DefaultPlanLifecycleManager();
    const releaseHandler = new FakeSessionBindingReleaseHandler();

    await manager.afterExecution(
      makeInput({
        cleanupService,
        sessionUuid: "session-1",
        baseSessionUuid: "session-1",
        args: {},
        sessionBindingReleaseHandler: releaseHandler,
      })
    );

    // Cleanup path is independent of the release path and stays untouched here.
    expect(cleanupService.calls).toEqual([]);
    // No real release happened, so the server-side binding teardown never fires.
    expect(releaseHandler.released).toEqual([]);
  });
});

// Exercises the REAL auto-release path (daemon initialized + live session) to
// prove afterExecution clears the server-side SessionToolBinding for every
// session it actually frees on an executePlan release (issue #4611 Gap D).
describe("DefaultPlanLifecycleManager server-side binding teardown (issue #4611 Gap D)", () => {
  let sessionManager: SessionManager;

  beforeEach(async () => {
    const timer = new FakeTimer();
    // In-memory migrated DB so createSession persists without resolving the real
    // ~/.auto-mobile file DB (CLAUDE.md unit-test guard, issue #3067).
    sessionManager = new SessionManager(timer, new DeviceSessionRepository(await createTestDatabase()));
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([androidDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
  });

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("notifies the release handler with the base session UUID after a plan auto-release", async () => {
    await sessionManager.createSession("base", androidDevice.deviceId, "android");
    const cleanupService = new FakeAppCleanupService();
    const releaseHandler = new FakeSessionBindingReleaseHandler();
    const manager = new DefaultPlanLifecycleManager();

    await manager.afterExecution({
      name: "executePlan",
      args: {},
      baseSessionUuid: "base",
      cleanupService,
      device: androidDevice,
      sessionUuid: "base",
      shouldResolveDevice: true,
      sessionBindingReleaseHandler: releaseHandler,
    });

    // The base session is gone, and its transport binding was torn down.
    expect(sessionManager.getSession("base")).toBeNull();
    expect(releaseHandler.released).toEqual(["base"]);
  });

  test("removes capability overrides for an auto-released session", async () => {
    await sessionManager.createSession("base", androidDevice.deviceId, "android");
    const deletedSessions: string[] = [];
    const cleanupService = new FakeAppCleanupService();
    const manager = new DefaultPlanLifecycleManager();

    await manager.afterExecution({
      name: "executePlan",
      args: {},
      baseSessionUuid: "base",
      cleanupService,
      device: androidDevice,
      sessionUuid: "base",
      shouldResolveDevice: true,
      sessionToolProfileService: {
        deleteSession: async sessionUuid => {
          deletedSessions.push(sessionUuid);
        },
      },
    });

    expect(deletedSessions).toEqual(["base"]);
  });

  test("notifies the release handler for every derived label session it releases", async () => {
    await sessionManager.createSession("base", androidDevice.deviceId, "android");
    await sessionManager.createSession("base:B", androidDevice.deviceId, "android");
    sessionManager.setDeviceLabels("base", buildDeviceLabelMap(["A", "B"], "base"));

    const cleanupService = new FakeAppCleanupService();
    const releaseHandler = new FakeSessionBindingReleaseHandler();
    const manager = new DefaultPlanLifecycleManager();

    await manager.afterExecution({
      name: "executePlan",
      args: {},
      baseSessionUuid: "base",
      cleanupService,
      device: androidDevice,
      sessionUuid: "base",
      shouldResolveDevice: true,
      sessionBindingReleaseHandler: releaseHandler,
    });

    expect(releaseHandler.released).toContain("base");
    expect(releaseHandler.released).toContain("base:B");
    expect(sessionManager.getSession("base")).toBeNull();
    expect(sessionManager.getSession("base:B")).toBeNull();
  });
});
