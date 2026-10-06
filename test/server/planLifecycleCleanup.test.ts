import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import type { BootedDevice } from "../../src/models";
import {
  DefaultAppCleanupService,
  type AppCleanupConfig,
  type AppCleanupService,
} from "../../src/server/AppCleanupService";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import {
  DefaultPlanLifecycleManager,
  PLAN_APP_CLEANUP_CAP_MS,
  type PlanLifecycleInput,
} from "../../src/server/toolRegistry";
import { logger } from "../../src/utils/logger";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const devices: BootedDevice[] = [
  { name: "Pixel A", deviceId: "device-A", platform: "android" },
  { name: "Pixel B", deviceId: "device-B", platform: "android" },
  { name: "Pixel C", deviceId: "device-C", platform: "android" },
  { name: "iPhone", deviceId: "device-ios", platform: "ios", iosVersion: "18.0" },
];

class FakeAppCleanupService implements AppCleanupService {
  readonly calls: Array<{ device: BootedDevice; config: AppCleanupConfig }> = [];
  failingDeviceId?: string;
  /** Like the real terminate / clear-data actions, throw when the ambient signal is aborted. */
  throwWhenAmbientAborted = false;
  /** Block until the ambient signal aborts (a dead device that never answers). */
  hangUntilAmbientAborted = false;
  readonly abortedAtStart = new Map<string, boolean | undefined>();

  constructor(private readonly events: string[]) {}

  async cleanup(device: BootedDevice, config: AppCleanupConfig): Promise<void> {
    this.calls.push({ device, config });
    this.events.push(`cleanup-start:${device.deviceId}`);
    const signal = getAbortSignal();
    this.abortedAtStart.set(device.deviceId, signal?.aborted);
    if (this.throwWhenAmbientAborted) {
      signal?.throwIfAborted();
    }
    if (this.hangUntilAmbientAborted && signal) {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }
    if (device.deviceId === this.failingDeviceId) {
      this.events.push(`cleanup-rejected:${device.deviceId}`);
      throw new Error("injected cleanup failure");
    }
    this.events.push(`cleanup-end:${device.deviceId}`);
  }
}

describe("executePlan cleans every acquired device before release", () => {
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let events: string[];
  let cleanup: FakeAppCleanupService;
  let log: FakeLogger;
  const restores: Array<() => void> = [];
  const lifecycle = new DefaultPlanLifecycleManager();

  beforeEach(async () => {
    events = [];
    cleanup = new FakeAppCleanupService(events);
    log = new FakeLogger();
    for (const level of ["info", "debug", "warn"] as const) {
      const spy = spyOn(logger, level).mockImplementation(log[level].bind(log));
      restores.push(() => spy.mockRestore());
    }
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices(
      "android",
      devices.filter((d) => d.platform === "android"),
    );
    deviceManager.setBootedDevices(
      "ios",
      devices.filter((d) => d.platform === "ios"),
    );
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer,
        deviceManager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const releaseSession = sessionManager.releaseSession.bind(sessionManager);
    const release = spyOn(sessionManager, "releaseSession").mockImplementation((id, reason) => {
      events.push(`session-release:${id}`);
      return releaseSession(id, reason);
    });
    const free = spyOn(pool, "releaseDevice").mockImplementation(async (id) => {
      events.push(`release:${id}`);
    });
    restores.push(
      () => release.mockRestore(),
      () => free.mockRestore(),
    );
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    sessionManager.stopCleanupTimer();
    DaemonState.getInstance().reset();
  });

  const acquire = async (targets: BootedDevice[], labels = true): Promise<void> => {
    const names = targets.map((_, i) => String.fromCharCode(65 + i));
    const map = buildDeviceLabelMap(names, "base");
    for (const [i, target] of targets.entries()) {
      await sessionManager.createSession(map[names[i]], target.deviceId, target.platform);
    }
    if (labels) {
      sessionManager.setDeviceLabels("base", map);
    }
  };

  const input = (overrides: Partial<PlanLifecycleInput> = {}): PlanLifecycleInput => ({
    name: "executePlan",
    args: { cleanupAppId: "com.example.chat", cleanupClearAppData: true },
    baseSessionUuid: "base",
    sessionUuid: "base",
    device: devices[0],
    cleanupService: cleanup,
    shouldResolveDevice: true,
    ...overrides,
  });

  const expectCleanupBeforeRelease = (targets: BootedDevice[]): void => {
    expect(cleanup.calls).toEqual(
      targets.map((device) => ({
        device,
        config: { appId: "com.example.chat", clearAppData: true },
      })),
    );
    for (const target of targets) {
      expect(events.indexOf(`cleanup-start:${target.deviceId}`)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`cleanup-end:${target.deviceId}`)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`release:${target.deviceId}`)).toBeGreaterThan(
        events.indexOf(`cleanup-end:${target.deviceId}`),
      );
    }
    expect(sessionManager.getSession("base")).toBeNull();
  };

  test.each([2, 3])("cleans all %s devices once before any release", async (count) => {
    const targets = devices.slice(0, count);
    await acquire(targets);
    await lifecycle.afterExecution(input());
    expectCleanupBeforeRelease(targets);
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(count);
    // A clean cleanup adds no incomplete-cleanup summary.
    expect(log.at("warn")).toEqual([]);
  });

  test.each(["device-A", "device-B"])(
    "a rejected cleanup on %s warns without preventing other cleanups or releases",
    async (failingDeviceId) => {
      await acquire(devices.slice(0, 3));
      cleanup.failingDeviceId = failingDeviceId;
      await expect(lifecycle.afterExecution(input())).resolves.toBeUndefined();
      expect(cleanup.calls.map((call) => call.device.deviceId)).toEqual([
        "device-A",
        "device-B",
        "device-C",
      ]);
      expect(events.filter((event) => event.startsWith("release:"))).toEqual([
        "release:device-B",
        "release:device-C",
        "release:device-A",
      ]);
      for (const target of devices.slice(0, 3)) {
        const end = target.deviceId === failingDeviceId ? "cleanup-rejected" : "cleanup-end";
        expect(events.indexOf(`release:${target.deviceId}`)).toBeGreaterThan(
          events.indexOf(`${end}:${target.deviceId}`),
        );
      }
      const warnings = log.at("warn");
      expect(warnings).toHaveLength(2);
      expect(warnings[0].message).toContain(failingDeviceId);
      // One summary says the already-finalized plan result does not cover the failed cleanup.
      expect(warnings[1].message).toContain("app cleanup for com.example.chat was incomplete");
      expect(warnings[1].message).toContain(`failed on ${failingDeviceId}`);
      expect(warnings[1].message).toContain("already finalized and does not report this");
      expect(sessionManager.getSession("base:B")).toBeNull();
      expect(sessionManager.getSession("base:C")).toBeNull();
      expect(sessionManager.getSession("base")).toBeNull();
    },
  );

  test.each(["device-A", "device-B"])("skips a retired pooled device %s", async (id) => {
    await acquire(devices.slice(0, 3));
    const getDevice = pool.getDevice.bind(pool);
    const missing = spyOn(pool, "getDevice").mockImplementation((candidate) =>
      candidate === id ? null : getDevice(candidate),
    );
    restores.push(() => missing.mockRestore());
    await lifecycle.afterExecution(input());
    expect(cleanup.calls.map((call) => call.device.deviceId)).toEqual(
      devices
        .slice(0, 3)
        .filter((device) => device.deviceId !== id)
        .map((d) => d.deviceId),
    );
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(3);
    expect(log.at("debug").some((entry) => entry.message.includes(id))).toBe(true);
  });

  test("skips a label session that was already retired", async () => {
    await acquire(devices.slice(0, 3));
    await sessionManager.releaseSession("base:B");
    events.length = 0;
    await lifecycle.afterExecution(input());
    expectCleanupBeforeRelease([devices[0], devices[2]]);
    expect(log.at("debug").some((entry) => entry.message.includes("base:B"))).toBe(true);
  });

  test("skips a session fenced by the existing device-loss admission gate", async () => {
    await acquire(devices.slice(0, 3));
    const admit = pool.assertSessionReadyForAutomation.bind(pool);
    const lost = spyOn(pool, "assertSessionReadyForAutomation").mockImplementation((id) => {
      if (id === "base:B") {
        throw new DeviceLostError("device-B", "device lost during plan");
      }
      admit(id);
    });
    restores.push(() => lost.mockRestore());
    await lifecycle.afterExecution(input());
    expectCleanupBeforeRelease([devices[0], devices[2]]);
    expect(events).toContain("release:device-B");
    expect(log.at("debug").some((entry) => entry.message.includes("base:B"))).toBe(true);
  });

  test.each(["device-A", "device-B"])(
    "skips lost device %s before cancellation removes its session or pool entry",
    async (id) => {
      await acquire(devices.slice(0, 3));
      const controller = new AbortController();
      controller.abort(new DeviceLostError(id, "device lost during plan"));
      await runWithAbortSignal(controller.signal, () => lifecycle.afterExecution(input()));
      expectCleanupBeforeRelease(devices.slice(0, 3).filter((device) => device.deviceId !== id));
      expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(3);
      expect(log.at("debug").some((entry) => entry.message.includes(`lost device ${id}`))).toBe(
        true,
      );
    },
  );

  test.each([
    ["a request deadline or client cancel", () => new Error("request cancelled")],
    ["a sibling device loss", () => new DeviceLostError("device-B", "device lost during plan")],
  ])("cleans every owned device under a live signal after %s (#10022)", async (_label, reason) => {
    await acquire(devices.slice(0, 3));
    cleanup.throwWhenAmbientAborted = true;
    const controller = new AbortController();
    controller.abort(reason());
    await runWithAbortSignal(controller.signal, () => lifecycle.afterExecution(input()));
    const lost = controller.signal.reason instanceof DeviceLostError ? "device-B" : undefined;
    const owned = devices.slice(0, 3).filter((device) => device.deviceId !== lost);
    expectCleanupBeforeRelease(owned);
    expect([...cleanup.abortedAtStart.entries()]).toEqual(
      owned.map((device) => [device.deviceId, false]),
    );
    expect(events.filter((event) => event.startsWith("cleanup-rejected:"))).toEqual([]);
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(3);
  });

  test("a device that never answers cannot hang release past the cleanup cap", async () => {
    await acquire(devices.slice(0, 2));
    cleanup.hangUntilAmbientAborted = true;
    const timer = new FakeTimer();
    const capped = new DefaultPlanLifecycleManager(timer);
    const controller = new AbortController();
    controller.abort(new Error("request deadline"));
    const work = runWithAbortSignal(controller.signal, () => capped.afterExecution(input()));
    await Promise.resolve();
    expect(events.some((event) => event.startsWith("release:"))).toBe(false);
    timer.advanceTime(PLAN_APP_CLEANUP_CAP_MS);
    await work;
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(2);
    expect(
      log.at("warn").some((entry) => entry.message.includes("App cleanup did not finish")),
    ).toBe(true);
    expect(log.at("warn").some((entry) => entry.message.includes("App cleanup failed"))).toBe(true);
    expect(
      log
        .at("warn")
        .some((entry) =>
          entry.message.includes(`did not finish within ${PLAN_APP_CLEANUP_CAP_MS}ms`),
        ),
    ).toBe(true);
  });

  test("skips a pooled device with quarantined runtime identity", async () => {
    await acquire(devices.slice(0, 2));
    pool.getDevice("device-B")!.identityUnresolved = true;
    await lifecycle.afterExecution(input());
    expectCleanupBeforeRelease([devices[0]]);
    expect(events).toContain("release:device-B");
    expect(log.at("debug").some((entry) => entry.message.includes("base:B"))).toBe(true);
  });

  test("deduplicates devices even when different label sessions share an id", async () => {
    await acquire([devices[0], devices[0]]);
    sessionManager.setDeviceLabels("base", { A: "base", alias: "base", B: "base:B" });
    await lifecycle.afterExecution(input());
    expect(cleanup.calls).toHaveLength(1);
    expect(cleanup.calls[0].device).toEqual(devices[0]);
  });

  test.each([true, false])("single-device cleanup keeps its args (labels: %s)", async (labels) => {
    await acquire([devices[0]], labels);
    await lifecycle.afterExecution(input());
    expectCleanupBeforeRelease([devices[0]]);
    expect(events.filter((event) => event.startsWith("release:"))).toEqual(["release:device-A"]);
  });

  test.each(["no-app", "other-tool"])("does no cleanup for %s", async (scenario) => {
    await acquire(devices.slice(0, 2));
    await lifecycle.afterExecution(input(scenario === "no-app" ? { args: {} } : { name: "tapOn" }));
    expect(cleanup.calls).toEqual([]);
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(
      scenario === "no-app" ? 2 : 0,
    );
  });

  test("retains cleanup for a standalone device without a daemon session", async () => {
    DaemonState.getInstance().reset();
    await lifecycle.afterExecution(input({ baseSessionUuid: undefined, sessionUuid: undefined }));
    expect(cleanup.calls).toEqual([
      { device: devices[0], config: { appId: "com.example.chat", clearAppData: true } },
    ]);
  });

  test.each([true, false])(
    "mixed-platform factories receive each device and drain derived cleanup (clear: %s)",
    async (clearAppData) => {
      const targets = [devices[0], devices[1], devices[3]];
      await acquire(targets);
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      const factoryDevices: BootedDevice[] = [];
      const action = (device: BootedDevice) => {
        factoryDevices.push(device);
        return {
          execute: async (appId: string) => {
            events.push(`cleanup-start:${device.deviceId}`);
            if (device.platform === "ios") {
              started.resolve();
              await pending.promise;
            }
            events.push(`cleanup-end:${device.deviceId}`);
            return { success: true, packageName: appId, wasForeground: false };
          },
        };
      };
      const service = new DefaultAppCleanupService({
        createClearAppData: action,
        createTerminateApp: action,
        logger: log,
      });
      const work = lifecycle.afterExecution(
        input({
          cleanupService: service,
          args: { cleanupAppId: "com.example.chat", cleanupClearAppData: clearAppData },
        }),
      );
      // The primary-only implementation never enters the derived factory; fail
      // immediately instead of awaiting a signal it cannot deliver.
      try {
        await Promise.resolve();
        expect(factoryDevices).toEqual(targets);
        await started.promise;
        expect(events.some((event) => event.startsWith("release:"))).toBe(false);
      } finally {
        pending.resolve();
        await work;
      }
      for (const target of targets) {
        expect(events.indexOf(`release:${target.deviceId}`)).toBeGreaterThan(
          events.indexOf(`cleanup-end:${target.deviceId}`),
        );
      }
    },
  );
});
