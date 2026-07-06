import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultAuditRunner,
  DefaultPlanLifecycleManager,
  type AuditRunnerInput,
  type PlanLifecycleInput,
} from "../../src/server/toolRegistry";
import type { AppCleanupConfig, AppCleanupService } from "../../src/server/AppCleanupService";
import type { BootedDevice } from "../../src/models";
import { serverConfig } from "../../src/utils/ServerConfig";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { DaemonState } from "../../src/daemon/daemonState";
import { logger } from "../../src/utils/logger";

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

    const warnMessages: string[] = [];
    const originalWarn = logger.warn;
    logger.warn = ((message: string) => {
      warnMessages.push(message);
    }) as typeof logger.warn;

    try {
      let handlerCalled = false;
      const runner = new DefaultAuditRunner();
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
      expect(warnMessages.some(m => m.includes("skipping memory audit"))).toBe(true);
    } finally {
      logger.warn = originalWarn;
    }
  });

  test("swallows adb failures during foreground lookup and still runs the handler", async () => {
    serverConfig.setMemPerfAuditMode(true);
    (defaultAdbClientFactory as { create: typeof originalCreate }).create = (() => ({
      async executeCommand() {
        throw new Error("adb offline");
      },
    })) as unknown as typeof originalCreate;

    const warnMessages: string[] = [];
    const originalWarn = logger.warn;
    logger.warn = ((message: string) => {
      warnMessages.push(message);
    }) as typeof logger.warn;

    try {
      const runner = new DefaultAuditRunner();
      const result = await runner.run(
        makeInput(androidDevice, async () => ({ success: true, sentinel: "adb-error" }))
      );

      expect(result).toEqual({ success: true, sentinel: "adb-error" });
      expect(warnMessages.some(m => m.includes("Failed to get foreground package name"))).toBe(true);
    } finally {
      logger.warn = originalWarn;
    }
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

    await manager.afterExecution(
      makeInput({
        cleanupService,
        sessionUuid: "session-1",
        baseSessionUuid: "session-1",
        args: {},
      })
    );

    // Cleanup path is independent of the release path and stays untouched here.
    expect(cleanupService.calls).toEqual([]);
  });
});
