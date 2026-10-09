import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import type { BootedDevice } from "../../src/models";
import {
  DefaultAppCleanupService,
  type AppCleanupConfig,
  type AppCleanupOutcome,
  type AppCleanupService,
} from "../../src/server/AppCleanupService";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import * as deviceLabelMapping from "../../src/server/deviceLabelMapping";
import {
  DefaultPlanLifecycleManager,
  PLAN_APP_CLEANUP_CAP_MS,
  type PlanLifecycleInput,
} from "../../src/server/toolRegistry";
import { withReportedSessionHold } from "../../src/server/planTools";
import type { ExecutePlanResult } from "../../src/models/ExecutePlanResult";
import { logger } from "../../src/utils/logger";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { ClearAppData } from "../../src/features/action/ClearAppData";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
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
  /** Devices whose next N cleanups return a `failed` outcome (the service logs, never throws). */
  readonly softFailuresRemaining = new Map<string, number>();
  /** Like the real terminate / clear-data actions, throw when the ambient signal is aborted. */
  throwWhenAmbientAborted = false;
  /** Block until the ambient signal aborts (a dead device that never answers). */
  hangUntilAmbientAborted = false;
  /** Never settle, even once aborted (an adb call that ignores its signal). */
  hangForever = false;
  readonly abortedAtStart = new Map<string, boolean | undefined>();

  constructor(private readonly events: string[]) {}

  async cleanup(device: BootedDevice, config: AppCleanupConfig): Promise<AppCleanupOutcome> {
    this.calls.push({ device, config });
    this.events.push(`cleanup-start:${device.deviceId}`);
    const signal = getAbortSignal();
    this.abortedAtStart.set(device.deviceId, signal?.aborted);
    if (this.throwWhenAmbientAborted) {
      signal?.throwIfAborted();
    }
    if (this.hangForever) {
      await new Promise<void>(() => {});
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
    const remaining = this.softFailuresRemaining.get(device.deviceId) ?? 0;
    if (remaining > 0) {
      this.softFailuresRemaining.set(device.deviceId, remaining - 1);
      this.events.push(`cleanup-failed:${device.deviceId}`);
      return { status: "failed", step: "clearAppData", reason: "pm clear exited 1" };
    }
    this.events.push(`cleanup-end:${device.deviceId}`);
    return { status: "cleaned" };
  }
}

describe("executePlan cleans every acquired device before release", () => {
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let events: string[];
  let cleanup: FakeAppCleanupService;
  let log: FakeLogger;
  let timer: FakeTimer;
  let poolTimer: FakeTimer;
  /** Sessions whose release rejects, before or after the session manager removes them. */
  let releaseFaults: Map<string, "before-removal" | "after-removal">;
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
    timer = new FakeTimer();
    poolTimer = timer;
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
    releaseFaults = new Map();
    const release = spyOn(sessionManager, "releaseSession").mockImplementation(
      async (id, reason) => {
        events.push(`session-release:${id}`);
        const fault = releaseFaults.get(id);
        if (fault === "before-removal") {
          throw new Error(`injected release failure for ${id}`);
        }
        const result = await releaseSession(id, reason);
        if (fault === "after-removal") {
          throw new Error(`injected post-removal release failure for ${id}`);
        }
        return result;
      },
    );
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

  test("nested executePlan retains the outer session and assigned device without cleanup", async () => {
    await acquire([devices[0]], false);
    pool.getDevice("device-A")!.sessionId = "base";
    const session = sessionManager.getSession("base");

    await lifecycle.afterExecution(input({ nestedInPlan: true }));

    expect(sessionManager.getSession("base")).toBe(session);
    expect(pool.getDevice("device-A")!.sessionId).toBe("base");
    expect(cleanup.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("outermost executePlan still cleans and releases without a nested flag", async () => {
    await acquire([devices[0]], false);

    await lifecycle.afterExecution(input());

    expectCleanupBeforeRelease([devices[0]]);
    expect(events.filter((event) => event.startsWith("release:"))).toEqual(["release:device-A"]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  describe("holdSessionOnFailure (#10834)", () => {
    const failedResult: ExecutePlanResult = { success: false, executedSteps: 1, totalSteps: 2 };
    const hold = (overrides: Partial<PlanLifecycleInput> = {}): PlanLifecycleInput =>
      input({ args: { holdSessionOnFailure: true }, ...overrides });

    test("a failed plan with recovery pending keeps its session and device", async () => {
      await acquire([devices[0]], false);
      pool.getDevice("device-A")!.sessionId = "base";
      const session = sessionManager.getSession("base");

      await lifecycle.afterExecution(hold({ succeeded: false }));

      expect(sessionManager.getSession("base")).toBe(session);
      expect(pool.getDevice("device-A")!.sessionId).toBe("base");
      expect(events).toEqual([]);
    });

    test("a successful plan is released even when it asked to hold on failure", async () => {
      await acquire([devices[0]], false);

      await lifecycle.afterExecution(hold({ succeeded: true }));

      expect(sessionManager.getSession("base")).toBeNull();
      expect(events).toEqual(["session-release:base", "release:device-A"]);
    });

    test("a failed plan without the flag is released as before", async () => {
      await acquire([devices[0]], false);

      await lifecycle.afterExecution(input({ args: {}, succeeded: false }));

      expect(sessionManager.getSession("base")).toBeNull();
      expect(events).toEqual(["session-release:base", "release:device-A"]);
    });

    test("a failed plan with derived label sessions is always released", async () => {
      await acquire(devices.slice(0, 2));
      // The handler reports the decision before the lifecycle acts on it.
      expect(
        withReportedSessionHold(failedResult, { holdSessionOnFailure: true, sessionUuid: "base" })
          .sessionHeld,
      ).toBe(false);

      await lifecycle.afterExecution(hold({ succeeded: false }));

      for (const id of ["base", "base:B"]) {
        expect(sessionManager.getSession(id)).toBeNull();
      }
    });

    test("a failed single-label plan keeps its base session like an unlabeled plan (#11091)", async () => {
      await acquire([devices[0]]);
      expect(sessionManager.getDeviceLabels("base")).toEqual({ A: "base" });
      pool.getDevice("device-A")!.sessionId = "base";
      const session = sessionManager.getSession("base");

      await lifecycle.afterExecution(hold({ succeeded: false }));

      expect(sessionManager.getSession("base")).toBe(session);
      expect(pool.getDevice("device-A")!.sessionId).toBe("base");
      expect(events).toEqual([]);
      expect(
        withReportedSessionHold(failedResult, { holdSessionOnFailure: true, sessionUuid: "base" })
          .sessionHeld,
      ).toBe(true);
    });

    test("sessionHeld is reported only on a failed run that asked to hold", () => {
      const succeeded = { ...failedResult, success: true };
      expect(
        withReportedSessionHold(succeeded, { holdSessionOnFailure: true, sessionUuid: "base" }),
      ).not.toHaveProperty("sessionHeld");
      expect(withReportedSessionHold(failedResult, { sessionUuid: "base" })).not.toHaveProperty(
        "sessionHeld",
      );
    });
  });

  describe("auto-release frees every session independently (#11091)", () => {
    test("a failed derived release does not keep the other sessions on their devices", async () => {
      await acquire(devices.slice(0, 3));
      releaseFaults.set("base:B", "before-removal");

      await lifecycle.afterExecution(input({ args: {} }));

      expect(sessionManager.getSession("base:B")).not.toBeNull();
      for (const id of ["base", "base:C"]) {
        expect(sessionManager.getSession(id)).toBeNull();
      }
      expect(events).toContain("release:device-A");
      expect(events).toContain("release:device-C");
      expect(events).not.toContain("release:device-B");
      expect(
        log
          .at("warn")
          .some((entry) => entry.message.includes("Failed to release label session base:B")),
      ).toBe(true);
    });

    test("a base release rejecting after removal still frees its pool slot", async () => {
      await acquire(devices.slice(0, 2));
      releaseFaults.set("base", "after-removal");

      await lifecycle.afterExecution(input({ args: {} }));

      expect(sessionManager.getSession("base")).toBeNull();
      expect(sessionManager.getSession("base:B")).toBeNull();
      expect(events).toContain("release:device-A");
      expect(events).toContain("release:device-B");
    });
  });

  test("nested executePlan leaves every label session for the outer lifecycle", async () => {
    await acquire(devices.slice(0, 3));
    const releaseLabels = spyOn(deviceLabelMapping, "releaseDeviceLabelSessions");
    restores.push(() => releaseLabels.mockRestore());

    await lifecycle.afterExecution(input({ nestedInPlan: true, sessionUuid: "base:B" }));

    expect(releaseLabels).not.toHaveBeenCalled();
    for (const id of ["base", "base:B", "base:C"]) {
      expect(sessionManager.getSession(id)).not.toBeNull();
    }
    expect(sessionManager.getDeviceLabels("base")).toEqual({ A: "base", B: "base:B", C: "base:C" });
    expect(cleanup.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

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

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
  };
  const marker = (id: string) => pool.getDeviceHealthMarker(id)?.reason;

  test("a failed (non-throwing) cleanup is named in the summary and the device is marked app-cleanup", async () => {
    await acquire(devices.slice(0, 3));
    cleanup.softFailuresRemaining.set("device-B", 99);
    await lifecycle.afterExecution(input());
    const summary = log.at("warn").find((entry) => entry.message.includes("was incomplete"));
    expect(summary?.message).toContain("failed on device-B (clearAppData: pm clear exited 1)");
    expect(summary?.message).not.toContain("device-A");
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(3);
    expect(marker("device-B")).toBe("app-cleanup");
    expect(marker("device-A")).toBeUndefined();
    expect(marker("device-C")).toBeUndefined();
  });

  test("a rejected cleanup also marks the device", async () => {
    await acquire(devices.slice(0, 2));
    cleanup.failingDeviceId = "device-A";
    await lifecycle.afterExecution(input());
    expect(marker("device-A")).toBe("app-cleanup");
    expect(marker("device-B")).toBeUndefined();
  });

  test("a clean cleanup marks nothing", async () => {
    await acquire(devices.slice(0, 2));
    await lifecycle.afterExecution(input());
    for (const target of devices.slice(0, 2)) {
      expect(marker(target.deviceId)).toBeUndefined();
    }
  });

  test("the marked device's cleanup is retried under a live signal and the marker clears", async () => {
    await acquire(devices.slice(0, 2));
    cleanup.softFailuresRemaining.set("device-B", 1);
    cleanup.throwWhenAmbientAborted = true;
    const controller = new AbortController();
    controller.abort(new Error("request deadline"));
    await runWithAbortSignal(controller.signal, () => lifecycle.afterExecution(input()));
    expect(marker("device-B")).toBe("app-cleanup");
    expect(cleanup.calls.map((call) => call.device.deviceId)).toEqual(["device-A", "device-B"]);

    // The recovery is detached but inherits the aborted request signal unless it shields itself.
    poolTimer.advanceTime(1000);
    await flush();
    expect(cleanup.calls.map((call) => call.device.deviceId)).toEqual([
      "device-A",
      "device-B",
      "device-B",
    ]);
    expect(cleanup.calls[2].config).toEqual({ appId: "com.example.chat", clearAppData: true });
    expect(cleanup.abortedAtStart.get("device-B")).toBe(false);
    expect(marker("device-B")).toBeUndefined();
  });

  test("a device whose cleanup keeps failing stays marked after the bounded retries", async () => {
    await acquire(devices.slice(0, 1));
    cleanup.softFailuresRemaining.set("device-A", 99);
    await lifecycle.afterExecution(input());
    for (const delayMs of [1000, 2000, 4000]) {
      poolTimer.advanceTime(delayMs);
      await flush();
    }
    // The original attempt plus the three recovery attempts, then no more.
    expect(cleanup.calls).toHaveLength(4);
    poolTimer.advanceTime(60_000);
    await flush();
    expect(cleanup.calls).toHaveLength(4);
    expect(marker("device-A")).toBe("app-cleanup");
  });

  test("devices still running at the cap are marked and named as unfinished", async () => {
    await acquire(devices.slice(0, 2));
    cleanup.hangForever = true;
    const timer = new FakeTimer();
    const capped = new DefaultPlanLifecycleManager(timer);
    const work = capped.afterExecution(input());
    await Promise.resolve();
    timer.advanceTime(PLAN_APP_CLEANUP_CAP_MS);
    await work;
    const summary = log.at("warn").find((entry) => entry.message.includes("was incomplete"));
    expect(summary?.message).toContain("unfinished on device-A, device-B");
    expect(marker("device-A")).toBe("app-cleanup");
    expect(marker("device-B")).toBe("app-cleanup");
  });

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

  describe("iOS simulator clear-app-data through the real ClearAppData", () => {
    const iosCleanup = (simctl: FakeSimCtlClient) =>
      new DefaultAppCleanupService({
        createClearAppData: (device) =>
          new ClearAppData(device, undefined, {
            simctl,
            isSimulatorFn: () => true,
            cacheInvalidator: { invalidate: () => {} },
          }),
        logger: log,
      });

    test("an uninstalled bundle is cleaned and does not mark the simulator", async () => {
      await acquire([devices[3]]);
      const simctl = new FakeSimCtlClient();
      simctl.setInstalledApps([{ bundleId: "com.example.other" }]);
      await lifecycle.afterExecution(
        input({ device: devices[3], cleanupService: iosCleanup(simctl) }),
      );
      expect(marker("device-ios")).toBeUndefined();
      expect(log.at("warn").some((entry) => entry.message.includes("was incomplete"))).toBe(false);
    });

    test("a transient container failure on an installed bundle still marks the simulator", async () => {
      await acquire([devices[3]]);
      const simctl = new FakeSimCtlClient();
      simctl.setInstalledApps([{ bundleId: "com.example.chat" }]);
      simctl.setContainerError("com.example.chat", new Error("simctl get_app_container failed"));
      await lifecycle.afterExecution(
        input({ device: devices[3], cleanupService: iosCleanup(simctl) }),
      );
      expect(marker("device-ios")).toBe("app-cleanup");
    });

    test("an unreadable listing is not mistaken for an uninstalled bundle", async () => {
      await acquire([devices[3]]);
      const simctl = new FakeSimCtlClient();
      simctl.setListAppsError(new Error("simctl listapps timed out"));
      await lifecycle.afterExecution(
        input({ device: devices[3], cleanupService: iosCleanup(simctl) }),
      );
      expect(marker("device-ios")).toBe("app-cleanup");
    });
  });
});
