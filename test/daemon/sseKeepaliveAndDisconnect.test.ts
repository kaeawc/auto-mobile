import { planDisconnectMonitorHarness } from "./helpers/planDisconnectMonitorHarness";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DaemonDisconnectHarness, createPooledDevice } from "./helpers/DaemonDisconnectHarness";

import { getPerformanceMonitor } from "../../src/features/performance/PerformanceMonitor";
import { serverConfig } from "../../src/utils/ServerConfig";
import { MISSING_DEVICE_MISS_THRESHOLD } from "../../src/daemon/deviceLossMisses";
import { ADB_TRANSPORT_RESTART_GRACE_MS } from "../../src/utils/android-cmdline-tools/AdbTransportRestartRegistry";
import {
  evaluateDeviceDisconnects,
  recordingCandidateIncarnations,
  type DisconnectCandidateIncarnation,
} from "../../src/daemon/disconnectMonitor";
import { notifyAdbMissingDevice } from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { executionTracker } from "../../src/daemon/executionTracker";
import { waitForObservation, type WaitForWithSettled } from "../../src/server/observeTools";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { DeviceLossMisses } from "../../src/daemon/deviceLossMisses";
import { seededMisses } from "./helpers/seededMisses";

const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
afterEach(() => DaemonState.getInstance().reset());
const DEVICE_DISCONNECT_POLL_INTERVAL_MS = 5000;
const DEVICE_DISCONNECT_MISS_THRESHOLD = MISSING_DEVICE_MISS_THRESHOLD;

describe("physical Android device leaving adb devices (#10493)", () => {
  const PHONE = "57281FDCH00462";

  async function withInactivePlan(body: () => Promise<void>): Promise<void> {
    const previous = serverConfig.isPlanExecutionActive();
    const stopMonitoring = spyOn(getPerformanceMonitor(), "stopMonitoring").mockImplementation(
      () => {},
    );
    try {
      serverConfig.setPlanExecutionActive(false);
      await body();
    } finally {
      stopMonitoring.mockRestore();
      serverConfig.setPlanExecutionActive(previous);
    }
  }

  test("a physical device absent once is released within one tick", async () => {
    const h = planDisconnectMonitorHarness(PHONE);
    await withInactivePlan(async () => {
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      expect(h.actions).toContain(`remove:${PHONE}`);
      expect(h.daemon.confirmedDisconnected.has(PHONE)).toBe(true);
      expect(h.timer.getSleepHistory()).toEqual([]);
    });
  });

  test.each(["emulator-5554", "localhost:5555"])(
    "%s absent once is only a miss",
    async (deviceId) => {
      const h = planDisconnectMonitorHarness(deviceId);
      await withInactivePlan(async () => {
        await h.tick();
        expect(h.daemon.disconnectMisses.get(deviceId)).toBe(1);
        expect(h.actions).not.toContain("cancel:plan-session");
      });
    },
  );

  test("an ADB-offline physical device is held under the offline budget, not counted as missed", async () => {
    const h = planDisconnectMonitorHarness(PHONE);
    h.manager.offlineDeviceIds.add(PHONE);
    await withInactivePlan(async () => {
      await h.tick();
      // The real daemon holds a transitional (adb-offline) device under the offline episode
      // budget instead of counting a miss, so the phone is neither missed nor released.
      expect(h.daemon.disconnectMisses.has(PHONE)).toBe(false);
      expect(h.daemon.confirmedDisconnected.has(PHONE)).toBe(false);
      expect(h.actions).not.toContain("cancel:plan-session");
    });
  });

  test.each([
    ["every platform", ["android", "ios"]],
    ["only Android", ["android"]],
  ] as const)("a failed listing (%s) releases nothing", async (_label, failed) => {
    const h = planDisconnectMonitorHarness(PHONE);
    for (const platform of failed) {
      h.manager.failedPlatforms.add(platform);
    }
    await withInactivePlan(async () => {
      await h.tick();
      expect(h.daemon.disconnectMisses.has(PHONE)).toBe(false);
      expect(h.actions).not.toContain("cancel:plan-session");
      expect(h.actions).not.toContain(`remove:${PHONE}`);
    });
  });

  test("absent during an AutoMobile adb root restart is only a miss, then released after the grace", async () => {
    const h = planDisconnectMonitorHarness(PHONE);
    await withInactivePlan(async () => {
      const gate = Promise.withResolvers<void>();
      const restart = h.transportRestarts.runRestart(PHONE, () => gate.promise);
      await h.tick();
      expect(h.daemon.disconnectMisses.get(PHONE)).toBe(1);
      expect(h.actions).not.toContain("cancel:plan-session");
      gate.resolve();
      await restart;
      h.timer.advanceTime(ADB_TRANSPORT_RESTART_GRACE_MS - DEVICE_DISCONNECT_POLL_INTERVAL_MS);
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      expect(h.actions).toContain(`remove:${PHONE}`);
      expect(h.timer.getSleepHistory()).toEqual([]);
    });
  });

  test("after a release, the re-plugged phone's new session is kept", async () => {
    const h = planDisconnectMonitorHarness(PHONE);
    await withInactivePlan(async () => {
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      h.replug("new-owner");
      h.actions.length = 0;
      await h.tick();
      await h.tick();
      expect(h.daemon.disconnectMisses.has(PHONE)).toBe(false);
      expect(h.daemon.confirmedDisconnected.has(PHONE)).toBe(false);
      expect(h.actions).not.toContain("cancel:new-owner");
      expect(h.actions).not.toContain(`remove:${PHONE}`);
    });
  });
});

class FakeResponse {
  headersSent = true;
  writableEnded = false;
  destroyed = false;
  written: string[] = [];
  listeners: Map<string, Array<() => void>> = new Map();

  write(data: string): void {
    this.written.push(data);
  }

  on(event: string, callback: () => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  emit(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb();
    }
  }
}

describe("SSE keepalive timer", () => {
  test("writes keepalive comment every interval while response is writable", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written).toEqual([":keepalive\n\n"]);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written).toEqual([":keepalive\n\n", ":keepalive\n\n"]);
  });

  test("does not write keepalive before headers are sent", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();
    res.headersSent = false;

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written).toEqual([]);
  });

  test("does not write keepalive after response ends", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);

    res.writableEnded = true;
    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);
  });

  test("does not write keepalive after response is destroyed", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);

    res.destroyed = true;
    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);
  });

  test("clearKeepalive stops the interval", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    const keepaliveTimer = timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    const clearKeepalive = () => timer.clearInterval(keepaliveTimer);
    res.on("close", clearKeepalive);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);

    res.emit("close");
    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);
  });
});

type DiscoveryPlatform = "android" | "ios";

describe("disconnect monitor miss counting", () => {
  const runDisconnectPoll = (
    deviceDisconnectMisses: DeviceLossMisses,
    bootedDeviceIds: Set<string>,
    candidateDeviceIds: Set<string>,
    succeededPlatforms: Set<DiscoveryPlatform> = new Set(),
    candidatePlatforms: Map<string, DiscoveryPlatform> = new Map(),
    candidateIncarnations: Map<string, DisconnectCandidateIncarnation> = new Map(),
    deviceDisconnectMissIncarnations: Map<string, DisconnectCandidateIncarnation> = new Map(),
  ): { disconnected: string[]; skippedAllDiscoveryFailed: boolean } => {
    return evaluateDeviceDisconnects({
      deviceDisconnectMisses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds,
      candidateDeviceIds,
      succeededPlatforms,
      candidatePlatforms,
      candidateIncarnations,
      deviceDisconnectMissIncarnations,
    });
  };

  test("resets miss count when device appears in booted list", () => {
    const misses = new DeviceLossMisses();
    misses.set("device-1", 2);

    runDisconnectPoll(misses, new Set(["device-1"]), new Set(["device-1"]));
    expect(misses.has("device-1")).toBe(false);
  });

  // These three exercise the miss-counting mechanism itself. They simulate an
  // Android device ("ADB returning some devices but not ours"), so they name
  // its platform: a candidate with no platform at all is unverifiable by
  // construction and is deliberately never aged out (see below).
  const ANDROID_CANDIDATE = new Map<string, DiscoveryPlatform>([["device-1", "android"]]);
  const ANDROID_SUCCEEDED = new Set<DiscoveryPlatform>(["android"]);

  test("increments miss count when device is absent", () => {
    const misses = new DeviceLossMisses();

    runDisconnectPoll(misses, new Set(), new Set(["device-1"]));
    // No platform discovery succeeded, so retain the tracked device.
    expect(misses.has("device-1")).toBe(false);

    // Simulate ADB returning some devices but not ours
    runDisconnectPoll(
      misses,
      new Set(["other"]),
      new Set(["device-1"]),
      ANDROID_SUCCEEDED,
      ANDROID_CANDIDATE,
    );
    expect(misses.get("device-1")).toBe(1);

    runDisconnectPoll(
      misses,
      new Set(["other"]),
      new Set(["device-1"]),
      ANDROID_SUCCEEDED,
      ANDROID_CANDIDATE,
    );
    expect(misses.get("device-1")).toBe(2);
  });

  test("reports disconnect after threshold consecutive misses", () => {
    const misses = new DeviceLossMisses();

    for (let i = 1; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
      const result = runDisconnectPoll(
        misses,
        new Set(["other"]),
        new Set(["device-1"]),
        ANDROID_SUCCEEDED,
        ANDROID_CANDIDATE,
      );
      expect(result.disconnected).toEqual([]);
    }

    const result = runDisconnectPoll(
      misses,
      new Set(["other"]),
      new Set(["device-1"]),
      ANDROID_SUCCEEDED,
      ANDROID_CANDIDATE,
    );
    expect(result.disconnected).toEqual(["device-1"]);
  });

  /**
   * A device still assigned to a session but detached from the pool (ADB-reset
   * recovery) is added to the candidate set by id alone, with no
   * `candidatePlatforms` entry — `daemon.ts` cannot name a platform it no
   * longer tracks. No discovery source can be asked about such a candidate, so
   * ageing it out would disconnect a live session on the strength of a sweep
   * that never covered it (#5683 review).
   */
  test("never ages out a candidate whose platform is unknown", () => {
    const misses = new DeviceLossMisses();

    for (let i = 0; i <= DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
      const result = runDisconnectPoll(
        misses,
        new Set(["other"]),
        new Set(["orphaned-session-device"]),
        // Only devicectl completed: enough to clear the all-failed early
        // return, and still no way to verify a platformless candidate.
        new Set(),
        new Map(),
      );
      expect(result.disconnected).toEqual([]);
    }

    expect(misses.has("orphaned-session-device")).toBe(false);
  });

  test("miss-counts an Android candidate when Android discovery succeeds empty", () => {
    const misses = new DeviceLossMisses();

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["device-1"]),
      new Set(["android"]),
      new Map([["device-1", "android"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("device-1")).toBe(1);
  });

  test("miss-counts an iOS candidate when iOS discovery succeeds empty", () => {
    const misses = new DeviceLossMisses();

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["sim-1"]),
      new Set(["ios"]),
      new Map([["sim-1", "ios"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("sim-1")).toBe(1);
  });

  test("holds candidate misses when all platform discovery fails", () => {
    const misses = seededMisses([["device-1", 2]]);

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["device-1"]),
      new Set(),
      new Map([["device-1", "android"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(true);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("device-1")).toBe(2);
  });

  test("miss-counts only candidates whose platform discovery succeeds", () => {
    const misses = new DeviceLossMisses();

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["device-1", "sim-1"]),
      new Set(["android"]),
      new Map([
        ["device-1", "android"],
        ["sim-1", "ios"],
      ]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("device-1")).toBe(1);
    expect(misses.has("sim-1")).toBe(false);
  });

  test("a detached forced Android session follows the three-miss debounce", () => {
    const misses = new DeviceLossMisses();
    const forced = new Set(["emulator-5554"]);
    const input = {
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set<string>(),
      forceDisconnectedDeviceIds: forced,
      bootedDeviceIds: new Set<string>(),
      candidateDeviceIds: new Set(["emulator-5554"]),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map(),
    };

    for (let count = 1; count <= DEVICE_DISCONNECT_MISS_THRESHOLD; count++) {
      const result = evaluateDeviceDisconnects(input);
      expect(result.skippedAllDiscoveryFailed).toBe(false);
      expect(result.missed).toEqual([{ deviceId: "emulator-5554", misses: count }]);
      expect(result.disconnected).toEqual(
        count === DEVICE_DISCONNECT_MISS_THRESHOLD ? ["emulator-5554"] : [],
      );
      expect(misses.get("emulator-5554")).toBe(count);
      expect(forced.has("emulator-5554")).toBe(true);
    }
  });

  test("a forced missing device does not bypass the all-discovery-failed guard", () => {
    const misses = seededMisses([["emulator-5554", 1]]);
    const result = evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set(),
      forceDisconnectedDeviceIds: new Set(["emulator-5554"]),
      bootedDeviceIds: new Set(),
      candidateDeviceIds: new Set(["emulator-5554"]),
      succeededPlatforms: new Set(),
      succeededSources: new Set(),
      candidatePlatforms: new Map([["emulator-5554", "android" as const]]),
    });

    expect(result.skippedAllDiscoveryFailed).toBe(true);
    expect(result.disconnected).toEqual([]);
    expect(result.missed).toEqual([]);
    expect(misses.get("emulator-5554")).toBe(1);
  });

  test("fresh booted scan clears a stale forced missing flag", () => {
    const forceDisconnectedDeviceIds = new Set(["emulator-5554"]);
    const result = evaluateDeviceDisconnects({
      deviceDisconnectMisses: new DeviceLossMisses(),
      confirmedDisconnectedDeviceIds: new Set(),
      forceDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["emulator-5554"]),
      candidateDeviceIds: new Set(["emulator-5554"]),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map([["emulator-5554", "android" as const]]),
    });

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(forceDisconnectedDeviceIds.has("emulator-5554")).toBe(false);
  });

  test("a single adb missing report marks a tracked device suspect without preloading misses", () => {
    const daemon = new DaemonDisconnectHarness(new FakeTimer());
    daemon.getDevicePool().getDevice = () => createPooledDevice("emulator-5554");
    daemon.getSessionManager().getSessionForDevice = () => null;
    daemon.startMissingDeviceListener();
    try {
      notifyAdbMissingDevice("emulator-5554", new Error("device 'emulator-5554' not found"));
      expect(daemon.forcedDisconnected.has("emulator-5554")).toBe(true);
      expect(daemon.forceGenerations.get("emulator-5554")).toBe(1);
      expect(daemon.disconnectMisses.has("emulator-5554")).toBe(false);
    } finally {
      daemon.stopMissingDeviceListener();
    }
  });

  for (const waitFor of [
    { text: "Ready", timeout: 40_000 },
    { for: "appear", text: "Ready", timeout: 40_000 },
  ] satisfies WaitForWithSettled[]) {
    test(`raw ADB missing during a plan leaves ${"for" in waitFor ? "DSL" : "legacy"} waitFor running after fresh presence`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const planActive = spyOn(serverConfig, "isPlanExecutionActive").mockReturnValue(true);
      const tracked = executionTracker.startExecution("executePlan");
      executionTracker.bindDeviceExecution(tracked.id, "emulator-5554");
      const daemon = new DaemonDisconnectHarness(timer);
      const pool = daemon.getDevicePool();
      const pooledDevice = createPooledDevice("emulator-5554");
      pool.getDevice = () => pooledDevice;
      pool.isShutdownReserved = async () => false;
      daemon.getSessionManager().getSessionForDevice = () => null;
      daemon.startMissingDeviceListener();
      const screen = new FakeObserveScreen();
      screen.setObserveResult((index) => {
        if (index === 1) {
          notifyAdbMissingDevice(
            "emulator-5554",
            new Error("adb: device 'emulator-5554' not found"),
          );
          const confirmation = evaluateDeviceDisconnects({
            deviceDisconnectMisses: new DeviceLossMisses(),
            confirmedDisconnectedDeviceIds: new Set(),
            forceDisconnectedDeviceIds: daemon.forcedDisconnected,
            bootedDeviceIds: new Set(["emulator-5554"]),
            candidateDeviceIds: new Set(["emulator-5554"]),
            succeededPlatforms: new Set(["android"]),
            candidatePlatforms: new Map([["emulator-5554", "android"]]),
          });
          expect(confirmation.disconnected).toEqual([]);
        }
        return {
          observationId: `observation-${index}`,
          display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
          updatedAt: timer.now() + 1,
          screenSize: { width: 200, height: 200 },
          systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
          viewHierarchy: {
            updatedAt: timer.now() + 1,
            hierarchy: {
              node: {
                "resource-id": "root",
                bounds: { left: 0, top: 0, right: 200, bottom: 200 },
                node: [
                  {
                    text: index >= 2 ? "Ready" : "Waiting",
                    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
                  },
                ],
              },
            },
            screenWidth: 200,
            screenHeight: 200,
          },
        };
      });
      try {
        const outcome = await waitForObservation(screen, waitFor, {
          signal: tracked.abortController.signal,
          skipBackStack: false,
          timer,
        });
        expect(outcome.matched).toBe(true);
        expect(outcome.timedOut).toBe(false);
        expect(screen.getExecuteCallCount()).toBe(3);
        expect(tracked.abortController.signal.aborted).toBe(false);
        expect(tracked.cancelReason).toBeUndefined();
        expect(daemon.forcedDisconnected.size).toBe(0);
      } finally {
        daemon.stopMissingDeviceListener();
        executionTracker.endExecution(tracked.id);
        planActive.mockRestore();
      }
    });
  }

  test("raw ADB event burst during an unreserved plan restart queues no cancellation or reservation work", async () => {
    const planActive = spyOn(serverConfig, "isPlanExecutionActive").mockReturnValue(true);
    const tracked = executionTracker.startExecution("executePlan");
    executionTracker.bindDeviceExecution(tracked.id, "emulator-5554");
    const recovery = executionTracker.startExecution("startDevice");
    executionTracker.bindDeviceExecution(recovery.id, "emulator-5554");
    const otherClient = executionTracker.startExecution("observe", "other-client");
    executionTracker.bindDeviceExecution(otherClient.id, "emulator-5554");
    const otherDevice = executionTracker.startExecution("executePlan");
    executionTracker.bindDeviceExecution(otherDevice.id, "emulator-5556");
    const shutdownCheck = spyOn({ check: async () => false }, "check");
    const cancel = spyOn(executionTracker, "cancelDeviceExecutions");
    const daemon = new DaemonDisconnectHarness(new FakeTimer());
    const pool = daemon.getDevicePool();
    pool.getDevice = () => createPooledDevice("emulator-5554", { status: "busy" });
    pool.isShutdownReserved = shutdownCheck;
    daemon.getSessionManager().getSessionForDevice = () => "plan-session";
    daemon.startMissingDeviceListener();
    try {
      for (let i = 0; i < 710; i++) {
        notifyAdbMissingDevice("emulator-5554", new Error("device 'emulator-5554' not found"));
      }
      await drainMicrotasks(20);
      expect(cancel).not.toHaveBeenCalled();
      expect(shutdownCheck).not.toHaveBeenCalled();
      for (const execution of [tracked, recovery, otherClient, otherDevice]) {
        expect(execution.abortController.signal.aborted).toBe(false);
        expect(execution.cancelReason).toBeUndefined();
      }
      expect(daemon.forcedDisconnected).toEqual(new Set(["emulator-5554"]));
    } finally {
      daemon.stopMissingDeviceListener();
      for (const execution of [tracked, recovery, otherClient, otherDevice]) {
        executionTracker.endExecution(execution.id);
      }
      cancel.mockRestore();
      planActive.mockRestore();
    }
  });

  test("skips candidates from platforms whose discovery did not succeed", () => {
    const misses = new DeviceLossMisses();
    misses.set("sim-1", 2);

    // Android discovery succeeded; iOS discovery did not, so the iOS
    // simulator must not be miss-counted toward disconnect.
    const result = runDisconnectPoll(
      misses,
      new Set(["emulator-5554"]),
      new Set(["sim-1"]),
      new Set(["android"]),
      new Map([["sim-1", "ios"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("sim-1")).toBe(2);
  });

  test("miss-counts a device once its platform discovery succeeds", () => {
    const misses = new DeviceLossMisses();

    // iOS discovery succeeded but reported zero simulators, so an iOS
    // device that is genuinely gone should now be miss-counted.
    const result = runDisconnectPoll(
      misses,
      new Set(["emulator-5554"]),
      new Set(["sim-1"]),
      new Set(["android", "ios"]),
      new Map([["sim-1", "ios"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(misses.get("sim-1")).toBe(1);
  });

  test("miss count resets after device reappears then starts over", () => {
    const misses = new DeviceLossMisses();
    const poll = (booted: Set<string>) =>
      runDisconnectPoll(
        misses,
        booted,
        new Set(["device-1"]),
        ANDROID_SUCCEEDED,
        ANDROID_CANDIDATE,
      );

    poll(new Set(["other"]));
    poll(new Set(["other"]));
    expect(misses.get("device-1")).toBe(2);

    poll(new Set(["device-1"]));
    expect(misses.has("device-1")).toBe(false);

    poll(new Set(["other"]));
    expect(misses.get("device-1")).toBe(1);
  });

  test("does not carry misses from a replaced device incarnation", () => {
    const misses = seededMisses([["sim-1", 2]]);
    const candidateIncarnations = new Map<string, number>([["sim-1", 2]]);
    const deviceDisconnectMissIncarnations = new Map<string, number>([["sim-1", 1]]);

    const result = runDisconnectPoll(
      misses,
      new Set(["emulator-5554"]),
      new Set(["sim-1"]),
      new Set(["android", "ios"]),
      new Map([["sim-1", "ios"]]),
      candidateIncarnations,
      deviceDisconnectMissIncarnations,
    );

    expect(result.disconnected).toEqual([]);
    expect(misses.get("sim-1")).toBe(1);
    expect(deviceDisconnectMissIncarnations.get("sim-1")).toBe(2);
  });

  test("does not carry misses to a replacement recording-only lifecycle", () => {
    const misses = seededMisses([["sim-1", 2]]);
    const priorIncarnations = recordingCandidateIncarnations([
      { deviceId: "sim-1", recordingId: "recording-old" },
    ]);
    const replacementIncarnations = recordingCandidateIncarnations([
      { deviceId: "sim-1", recordingId: "recording-new" },
    ]);
    const deviceDisconnectMissIncarnations = new Map([["sim-1", priorIncarnations.get("sim-1")!]]);

    const result = runDisconnectPoll(
      misses,
      new Set(["emulator-5554"]),
      new Set(["sim-1"]),
      new Set(["android", "ios"]),
      new Map([["sim-1", "ios"]]),
      replacementIncarnations,
      deviceDisconnectMissIncarnations,
    );

    expect(result.disconnected).toEqual([]);
    expect(misses.get("sim-1")).toBe(1);
    expect(deviceDisconnectMissIncarnations.get("sim-1")).toBe(
      replacementIncarnations.get("sim-1"),
    );
  });

  test("clears miss state after a candidate stops being tracked", () => {
    const misses = seededMisses([["sim-1", 2]]);
    const confirmedDisconnectedDeviceIds = new Set(["sim-1"]);

    evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["emulator-5554"]),
      candidateDeviceIds: new Set(),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map(),
    });

    expect(misses.has("sim-1")).toBe(false);
    expect(confirmedDisconnectedDeviceIds.has("sim-1")).toBe(false);
  });

  test("clears confirmed state after a recording-only candidate stops being tracked", () => {
    const confirmedDisconnectedDeviceIds = new Set(["sim-1"]);

    evaluateDeviceDisconnects({
      deviceDisconnectMisses: new DeviceLossMisses(),
      confirmedDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["emulator-5554"]),
      candidateDeviceIds: new Set(),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map(),
    });

    expect(confirmedDisconnectedDeviceIds.has("sim-1")).toBe(false);
  });

  test("clears a confirmed marker for a newly pooled candidate", () => {
    const confirmedDisconnectedDeviceIds = new Set(["sim-1"]);
    const misses = new DeviceLossMisses();

    evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["emulator-5554"]),
      candidateDeviceIds: new Set(["sim-1"]),
      succeededPlatforms: new Set(["android" as const, "ios" as const]),
      candidatePlatforms: new Map([["sim-1", "ios" as const]]),
      candidateIncarnations: new Map([["sim-1", 2]]),
    });

    expect(confirmedDisconnectedDeviceIds.has("sim-1")).toBe(false);
    expect(misses.get("sim-1")).toBe(1);
  });

  test("keeps returning a threshold-missed stale candidate until caller settles cleanup", () => {
    const misses = new DeviceLossMisses();
    const confirmedDisconnectedDeviceIds = new Set<string>();
    const input = {
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["other"]),
      candidateDeviceIds: new Set(["device-1"]),
      succeededPlatforms: new Set(["android" as const, "ios" as const]),
      candidatePlatforms: new Map([["device-1", "android" as const]]),
    };

    expect(evaluateDeviceDisconnects(input).disconnected).toEqual([]);
    expect(evaluateDeviceDisconnects(input).disconnected).toEqual([]);
    expect(evaluateDeviceDisconnects(input).disconnected).toEqual(["device-1"]);
    expect(confirmedDisconnectedDeviceIds.has("device-1")).toBe(false);
    expect(misses.get("device-1")).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD);

    expect(evaluateDeviceDisconnects(input).disconnected).toEqual(["device-1"]);
    expect(misses.get("device-1")).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD);

    confirmedDisconnectedDeviceIds.add("device-1");

    expect(evaluateDeviceDisconnects(input).disconnected).toEqual([]);
    expect(misses.has("device-1")).toBe(false);
  });

  test("clears settled disconnect state when the device reappears", () => {
    const confirmedDisconnectedDeviceIds = new Set(["device-1"]);
    const misses = new DeviceLossMisses();

    evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["device-1"]),
      candidateDeviceIds: new Set(["device-1"]),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map([["device-1", "android" as const]]),
    });

    expect(confirmedDisconnectedDeviceIds.has("device-1")).toBe(false);
  });

  /** A daemon whose disconnect state tracks one device the way a confirmed disconnect leaves it. */
  function disconnectedDaemon(deviceId: string, missIncarnation: number, forceGeneration: number) {
    const daemon = new DaemonDisconnectHarness(new FakeTimer());
    daemon.disconnectMisses.set(deviceId, DEVICE_DISCONNECT_MISS_THRESHOLD);
    daemon.missIncarnations.set(deviceId, missIncarnation);
    daemon.confirmedDisconnected.add(deviceId);
    daemon.forcedDisconnected.add(deviceId);
    daemon.forceGenerations.set(deviceId, forceGeneration);
    return daemon;
  }

  test("clears disconnect state when an absent candidate is pooled before cleanup", async () => {
    const daemon = disconnectedDaemon("sim-1", 1, 0);
    daemon.forceGenerations.delete("sim-1");
    daemon.getDevicePool().getDevice = () => createPooledDevice("sim-1");

    await expect(daemon.shouldSkipStaleCleanup(null, "sim-1")).resolves.toBe(true);
    expect(daemon.disconnectMisses.has("sim-1")).toBe(false);
    expect(daemon.missIncarnations.has("sim-1")).toBe(false);
    expect(daemon.confirmedDisconnected.has("sim-1")).toBe(false);
    expect(daemon.forcedDisconnected.has("sim-1")).toBe(false);
  });

  test("retains a replacement force marker when null-captured cleanup finds a pooled device", async () => {
    const daemon = disconnectedDaemon("sim-1", 1, 2);
    daemon.getDevicePool().getDevice = () => createPooledDevice("sim-1");

    await expect(daemon.shouldSkipStaleCleanup(null, "sim-1", 1)).resolves.toBe(true);
    expect(daemon.forcedDisconnected.has("sim-1")).toBe(true);
    expect(daemon.forceGenerations.get("sim-1")).toBe(2);
  });

  test("clears disconnect state when cleanup rediscovers the pooled incarnation", async () => {
    const daemon = disconnectedDaemon("emulator-5554", 4, 1);
    daemon.getDevicePool().isCurrentDisconnectedDevice = async () => "recovered";

    await expect(
      daemon.shouldSkipStaleCleanup(createPooledDevice("emulator-5554"), "emulator-5554"),
    ).resolves.toBe(true);
    expect(daemon.disconnectMisses.has("emulator-5554")).toBe(false);
    expect(daemon.missIncarnations.has("emulator-5554")).toBe(false);
    expect(daemon.confirmedDisconnected.has("emulator-5554")).toBe(false);
    expect(daemon.forcedDisconnected.has("emulator-5554")).toBe(false);
  });

  test("preserves a force signal raised during recovery verification", async () => {
    let resolveVerification: (() => void) | undefined;
    const verification = new Promise<void>((resolve) => {
      resolveVerification = resolve;
    });
    const daemon = disconnectedDaemon("emulator-5554", 4, 1);
    daemon.forcedDisconnected.clear();
    daemon.forceGenerations.clear();
    daemon.getDevicePool().isCurrentDisconnectedDevice = async () => {
      await verification;
      return "recovered";
    };

    const pending = daemon.shouldSkipStaleCleanup(
      createPooledDevice("emulator-5554"),
      "emulator-5554",
    );
    daemon.forcedDisconnected.add("emulator-5554");
    daemon.forceGenerations.set("emulator-5554", 1);
    resolveVerification?.();

    await expect(pending).resolves.toBe(true);
    expect(daemon.forcedDisconnected.has("emulator-5554")).toBe(true);
    expect(daemon.forceGenerations.get("emulator-5554")).toBe(1);
  });

  test("rejects an old disconnect target after cancellation races a same-ID replacement", () => {
    const capturedDevice = createPooledDevice("emulator-5554", { assignmentCount: 4 });
    const replacementDevice = createPooledDevice("emulator-5554", { assignmentCount: 1 });
    const daemon = new DaemonDisconnectHarness(new FakeTimer());
    daemon.getDevicePool().getDevice = () => replacementDevice;
    daemon.getSessionManager().getSessionForDevice = () => null;

    expect(
      daemon.isCapturedTargetCurrent("emulator-5554", {
        pooledDeviceAtDisconnect: capturedDevice,
        assignmentCountAtDisconnect: 4,
      }),
    ).toBe(false);
  });

  test("retains disconnect state when cleanup verification is inconclusive", async () => {
    const daemon = disconnectedDaemon("emulator-5554", 4, 1);
    daemon.getDevicePool().isCurrentDisconnectedDevice = async () => "unknown";

    await expect(
      daemon.shouldSkipStaleCleanup(createPooledDevice("emulator-5554"), "emulator-5554"),
    ).resolves.toBe(true);
    expect(daemon.disconnectMisses.get("emulator-5554")).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD);
    expect(daemon.missIncarnations.get("emulator-5554")).toBe(4);
    expect(daemon.confirmedDisconnected.has("emulator-5554")).toBe(true);
    expect(daemon.forcedDisconnected.has("emulator-5554")).toBe(true);
  });

  test("fires at poll interval using FakeTimer", () => {
    const timer = new FakeTimer();
    let pollCount = 0;

    timer.setInterval(() => {
      pollCount++;
    }, DEVICE_DISCONNECT_POLL_INTERVAL_MS);

    expect(pollCount).toBe(0);

    timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
    expect(pollCount).toBe(1);

    timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
    expect(pollCount).toBe(2);

    timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
    expect(pollCount).toBe(3);
  });
});
