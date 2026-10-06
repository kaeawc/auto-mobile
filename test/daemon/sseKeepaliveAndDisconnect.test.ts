import { describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import type { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video";
import { getPerformanceMonitor } from "../../src/features/performance/PerformanceMonitor";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import { serverConfig } from "../../src/utils/ServerConfig";
import { logger } from "../../src/utils/logger";
import { MISSING_DEVICE_MISS_THRESHOLD } from "../../src/daemon/missingDeviceLiveness";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import {
  evaluateDeviceDisconnects,
  recordingCandidateIncarnations,
} from "../../src/daemon/disconnectMonitor";
import { notifyAdbMissingDevice } from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { executionTracker } from "../../src/server/executionTracker";
import { waitForObservation, type WaitForWithSettled } from "../../src/server/observeTools";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
const DEVICE_DISCONNECT_POLL_INTERVAL_MS = 5000;
const DEVICE_DISCONNECT_MISS_THRESHOLD = MISSING_DEVICE_MISS_THRESHOLD;
const PLAN_DISCONNECT_MISS_CAP = DEVICE_DISCONNECT_MISS_THRESHOLD - 2;

interface PlanDisconnectMonitorSurface {
  deviceDisconnectMonitor: SingleFlightInterval;
  deviceDisconnectMisses: Map<string, number>;
  confirmedDisconnectedDeviceIds: Set<string>;
  offlineRecoveryAttemptedDeviceIds: Set<string>;
  offlineRecoveryAttemptedIncarnations: Map<string, number | string>;
  startDeviceDisconnectMonitor(
    manager: Pick<
      MultiPlatformDeviceManager,
      "getBootedDevicesDetailed" | "getAndroidOfflineDeviceIds" | "recoverAndroidOfflineDevices"
    >,
    listRecordings: () => Promise<VideoRecordingRecord[]>,
  ): void;
}

function planDisconnectMonitorHarness() {
  const timer = new FakeTimer();
  const actions: string[] = [];
  const device = {
    id: "emulator-5554",
    platform: "android" as const,
    incarnation: 1,
    assignmentCount: 1,
    sessionId: "plan-session",
    status: "busy" as "busy" | "booting",
    avdName: "Pixel",
    androidImage: {},
  };
  let pooled = true;
  let sessionActive = true;
  const session = {
    sessionId: device.sessionId,
    assignedDevice: device.id,
    platform: device.platform,
  };
  const devices = [device];
  class PlanDeviceManager extends FakeDeviceManager {
    discoveryCalls = 0;
    offlineProbeCalls = 0;
    offlineDeviceIds = new Set<string>();
    onDiscovery = () => {};
    onRecovery = () => {};
    async getBootedDevicesDetailed(
      platform: Parameters<FakeDeviceManager["getBootedDevicesDetailed"]>[0],
    ) {
      this.discoveryCalls++;
      const discovery = await super.getBootedDevicesDetailed(platform);
      this.onDiscovery();
      return discovery;
    }
    async getAndroidOfflineDeviceIds() {
      this.offlineProbeCalls++;
      return this.offlineDeviceIds;
    }
    async recoverAndroidOfflineDevices() {
      actions.push("offline-reconnect");
      this.onRecovery();
    }
  }
  const manager = new PlanDeviceManager();
  const recordings: VideoRecordingRecord[] = [
    {
      recordingId: "plan-recording",
      deviceId: device.id,
      platform: device.platform,
      status: "recording",
      fileName: "plan-recording.mp4",
      filePath: "plan-recording.mp4",
      format: "mp4",
      sizeBytes: 0,
      createdAt: "2026-10-02T00:00:00Z",
      startedAt: "2026-10-02T00:00:00Z",
      lastAccessedAt: "2026-10-02T00:00:00Z",
      config: DEFAULT_VIDEO_RECORDING_CONFIG,
    },
  ];
  // Exercise the real daemon tick with only its dependencies replaced, without
  // constructing the daemon's unrelated database/socket/process services.
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    timer,
    deviceDisconnectMonitor: null,
    deviceDisconnectMisses: new Map<string, number>(),
    deviceDisconnectMissIncarnations: new Map(),
    confirmedDisconnectedDeviceIds: new Set<string>(),
    forceDisconnectedDeviceIds: new Set<string>(),
    forceDisconnectedDeviceGenerations: new Map(),
    offlineRecoveryAttemptedDeviceIds: new Set(),
    offlineRecoveryAttemptedIncarnations: new Map(),
    deferredSessionRecoverySweeps: new Set(),
    devicePool: {
      retryDueDeferredSessionRecoveries: async () => {
        actions.push("deferred-recovery");
      },
      reconcileDiscoveryObservation: async () => {
        actions.push("reconcile");
      },
      getAllDevices: () => (pooled ? devices : []),
      getDevice: (id: string) => (pooled && id === device.id ? device : null),
      isDeviceLeasedForAndroidStartup: () => false,
      detachAdbServerResetCohort: async () => {
        actions.push("detach-reset-cohort");
        return { devices: [], deferred: false };
      },
      releaseAdbServerResetCohortReservations: async () => {
        actions.push("release-reset-cohort");
      },
      removeDisconnectedDevice: async (id: string) => {
        actions.push(`remove:${id}`);
        pooled = false;
      },
    },
    sessionManager: {
      getAllSessions: () => (sessionActive ? [session] : []),
      getSessionForDevice: () => (sessionActive ? session.sessionId : null),
      getSession: () => (sessionActive ? session : null),
    },
    shouldSkipStaleDisconnectCleanup: async () => false,
    recordAndTryRecoverCapturedDisconnect: async () => {
      actions.push("device-loss-recovery");
      return { incidentId: undefined, handled: false };
    },
    cancelAndReleaseSession: async (id: string) => {
      actions.push(`cancel:${id}`);
      sessionActive = false;
    },
    stopRecordingAfterDeviceDisconnect: async () => {
      actions.push("stop-recording");
      return true;
    },
  }) as PlanDisconnectMonitorSurface;
  const recordingsReader = {
    calls: 0,
    async list() {
      this.calls++;
      return recordings;
    },
  };
  daemon.startDeviceDisconnectMonitor(manager, () => recordingsReader.list());
  return {
    daemon,
    manager,
    device,
    devices,
    timer,
    actions,
    recordingsReader,
    async tick() {
      timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
      // run() joins the tick just fired by FakeTimer; it does not start another.
      await daemon.deviceDisconnectMonitor.run();
    },
  };
}

describe("disconnect monitor during plan execution", () => {
  test("defers the whole tick when the plan ends during discovery, then reconciles before cleanup", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const planActive = spyOn(serverConfig, "isPlanExecutionActive");
    const stopMonitoring = spyOn(getPerformanceMonitor(), "stopMonitoring").mockImplementation(
      () => {},
    );
    try {
      serverConfig.setPlanExecutionActive(true);
      h.daemon.deviceDisconnectMisses.set(h.device.id, DEVICE_DISCONNECT_MISS_THRESHOLD - 1);
      h.manager.onDiscovery = () => serverConfig.setPlanExecutionActive(false);
      await h.tick();
      expect(h.actions).toEqual([]);
      expect(planActive).toHaveBeenCalledTimes(1);
      expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(PLAN_DISCONNECT_MISS_CAP);
      expect(h.recordingsReader.calls).toBe(0);
      expect(h.manager.offlineProbeCalls).toBe(0);
      expect(stopMonitoring).not.toHaveBeenCalled();
      await h.tick();
      expect(h.actions).toEqual(["deferred-recovery", "reconcile"]);
      expect(planActive).toHaveBeenCalledTimes(2);
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      expect(h.actions).toContain(`remove:${h.device.id}`);
      expect(h.actions).toContain("stop-recording");
      expect(h.actions.indexOf("reconcile")).toBeLessThan(
        h.actions.indexOf("device-loss-recovery"),
      );
      expect(planActive).toHaveBeenCalledTimes(3);
    } finally {
      serverConfig.setPlanExecutionActive(previous);
      planActive.mockRestore();
      stopMonitoring.mockRestore();
    }
  });

  test("keeps the inactive snapshot for reconciliation after offline recovery", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const planActive = spyOn(serverConfig, "isPlanExecutionActive");
    try {
      serverConfig.setPlanExecutionActive(false);
      h.manager.offlineDeviceIds.add(h.device.id);
      h.manager.onRecovery = () => {
        serverConfig.setPlanExecutionActive(true);
        h.manager.bootedDevices = [{ deviceId: h.device.id, name: "Pixel", platform: "android" }];
      };
      await h.tick();
      expect(h.actions).toEqual([
        "deferred-recovery",
        "reconcile",
        "offline-reconnect",
        "reconcile",
      ]);
      expect(planActive).toHaveBeenCalledTimes(1);
      expect(h.daemon.deviceDisconnectMisses.size).toBe(0);
    } finally {
      serverConfig.setPlanExecutionActive(previous);
      planActive.mockRestore();
    }
  });

  test("skips deferred-action reads and preserves offline attempts while logging the cap once", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const attempted = h.daemon.offlineRecoveryAttemptedDeviceIds;
    const incarnations = h.daemon.offlineRecoveryAttemptedIncarnations;
    attempted.add(h.device.id);
    incarnations.set(h.device.id, h.device.incarnation);
    try {
      serverConfig.setPlanExecutionActive(true);
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD + 1; i++) {
        await h.tick();
      }
      expect(h.recordingsReader.calls).toBe(0);
      expect(h.manager.offlineProbeCalls).toBe(0);
      expect(h.daemon.offlineRecoveryAttemptedDeviceIds).toBe(attempted);
      expect([...attempted]).toEqual([h.device.id]);
      expect(h.daemon.offlineRecoveryAttemptedIncarnations).toBe(incarnations);
      expect(incarnations.get(h.device.id)).toBe(h.device.incarnation);
      const missMessage = `[DisconnectMonitor] Device ${h.device.id} not in booted list (absent, miss ${PLAN_DISCONNECT_MISS_CAP}/${DEVICE_DISCONNECT_MISS_THRESHOLD}, booted=0)`;
      expect(info.mock.calls.filter(([message]) => message === missMessage)).toHaveLength(1);
      expect(debug.mock.calls.filter(([message]) => message === missMessage)).toHaveLength(
        DEVICE_DISCONNECT_MISS_THRESHOLD,
      );
      expect(h.actions).toEqual([]);
    } finally {
      serverConfig.setPlanExecutionActive(previous);
      info.mockRestore();
      debug.mockRestore();
    }
  });

  test("caps plan-time absence and cancels the lost session on the second inactive tick", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const stopMonitoring = spyOn(getPerformanceMonitor(), "stopMonitoring").mockImplementation(
      () => {},
    );
    try {
      serverConfig.setPlanExecutionActive(true);
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD + 1; i++) {
        await h.tick();
        expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(
          Math.min(i + 1, PLAN_DISCONNECT_MISS_CAP),
        );
        expect(h.actions).toEqual([]);
        expect(h.daemon.confirmedDisconnectedDeviceIds.size).toBe(0);
      }
      expect(h.manager.discoveryCalls).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD + 1);
      expect(stopMonitoring).not.toHaveBeenCalled();
      serverConfig.setPlanExecutionActive(false);
      await h.tick();
      expect(h.actions).toEqual(["deferred-recovery", "reconcile"]);
      expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(
        DEVICE_DISCONNECT_MISS_THRESHOLD - 1,
      );
      expect(h.daemon.confirmedDisconnectedDeviceIds.size).toBe(0);
      expect(stopMonitoring).not.toHaveBeenCalled();
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      expect(h.actions).toContain(`remove:${h.device.id}`);
      expect(h.actions).toContain("stop-recording");
      expect(h.daemon.confirmedDisconnectedDeviceIds.has(h.device.id)).toBe(true);
      expect(h.daemon.deviceDisconnectMisses.has(h.device.id)).toBe(false);
      expect(stopMonitoring).toHaveBeenCalledWith(h.device.id);
    } finally {
      serverConfig.setPlanExecutionActive(previous);
      stopMonitoring.mockRestore();
    }
  });

  test("counts a newly booting device without reaping it and clears misses when boot completes", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const plan = executionTracker.startExecution("executePlan", undefined, h.device.sessionId);
    executionTracker.bindDeviceExecution(plan.id, h.device.id);
    h.device.status = "booting";
    try {
      serverConfig.setPlanExecutionActive(true);
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(PLAN_DISCONNECT_MISS_CAP);
      expect(h.daemon.confirmedDisconnectedDeviceIds.size).toBe(0);
      expect(h.actions).toEqual([]);
      expect(h.device.status).toBe("booting");
      expect(plan.abortController.signal.aborted).toBe(false);
      expect(h.timer.getSleepHistory()).toEqual([]);
      expect(h.device.sessionId).toBe("plan-session");
      h.manager.bootedDevices = [{ deviceId: h.device.id, name: "Pixel", platform: "android" }];
      // Present observations clear the accumulated absence even during allocation.
      await h.tick();
      expect(h.daemon.deviceDisconnectMisses.has(h.device.id)).toBe(false);
      expect(h.actions).toEqual([]);
      h.manager.bootedDevices = [];
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(PLAN_DISCONNECT_MISS_CAP);
      h.manager.bootedDevices = [{ deviceId: h.device.id, name: "Pixel", platform: "android" }];
      serverConfig.setPlanExecutionActive(false);
      h.device.status = "busy";
      await h.tick();
      expect(h.daemon.deviceDisconnectMisses.has(h.device.id)).toBe(false);
      expect(h.daemon.confirmedDisconnectedDeviceIds.size).toBe(0);
      expect(h.actions).not.toContain("cancel:plan-session");
      expect(h.actions).not.toContain(`remove:${h.device.id}`);
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.actions).not.toContain("cancel:plan-session");
      expect(h.actions).not.toContain(`remove:${h.device.id}`);
      expect(h.actions).not.toContain("stop-recording");
    } finally {
      executionTracker.endExecution(plan.id);
      serverConfig.setPlanExecutionActive(previous);
    }
  });

  test("non-plan sessions retain all three discovery misses of restart grace", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const stopMonitoring = spyOn(getPerformanceMonitor(), "stopMonitoring").mockImplementation(
      () => {},
    );
    try {
      serverConfig.setPlanExecutionActive(false);
      for (let misses = 1; misses < DEVICE_DISCONNECT_MISS_THRESHOLD; misses++) {
        await h.tick();
        expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(misses);
        expect(h.actions).not.toContain("cancel:plan-session");
      }
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      expect(h.timer.getSleepHistory()).toEqual([]);
    } finally {
      stopMonitoring.mockRestore();
      serverConfig.setPlanExecutionActive(previous);
    }
  });

  test("counts misses while deferring offline reconnect and ADB reset cohort actions", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    try {
      h.devices.push({ ...h.device, id: "emulator-5556", avdName: "Pixel_2" });
      Object.assign(h.daemon, { forceDisconnectedDeviceIds: new Set([h.device.id]) });
      h.manager.offlineDeviceIds.add(h.device.id);
      serverConfig.setPlanExecutionActive(true);
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(PLAN_DISCONNECT_MISS_CAP);
      expect(h.daemon.deviceDisconnectMisses.get("emulator-5556")).toBe(PLAN_DISCONNECT_MISS_CAP);
      expect(h.daemon.confirmedDisconnectedDeviceIds.size).toBe(0);
      expect(h.actions).toEqual([]);
      expect(h.daemon.offlineRecoveryAttemptedDeviceIds.size).toBe(0);
      h.manager.onRecovery = () => {
        h.manager.bootedDevices = [
          { deviceId: h.device.id, name: "Pixel", platform: "android" },
          { deviceId: "emulator-5556", name: "Pixel_2", platform: "android" },
        ];
      };
      serverConfig.setPlanExecutionActive(false);
      await h.tick();
      expect(h.daemon.deviceDisconnectMisses.size).toBe(0);
      expect(h.actions).toEqual([
        "deferred-recovery",
        "reconcile",
        "offline-reconnect",
        "reconcile",
      ]);
    } finally {
      serverConfig.setPlanExecutionActive(previous);
    }
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

describe("disconnect monitor miss counting", () => {
  const runDisconnectPoll = (
    deviceDisconnectMisses: Map<string, number>,
    bootedDeviceIds: Set<string>,
    candidateDeviceIds: Set<string>,
    succeededPlatforms: Set<string> = new Set(),
    candidatePlatforms: Map<string, string> = new Map(),
    candidateIncarnations: Map<string, number> = new Map(),
    deviceDisconnectMissIncarnations: Map<string, number> = new Map(),
  ): { disconnected: string[]; skippedAllDiscoveryFailed: boolean } => {
    return evaluateDeviceDisconnects({
      deviceDisconnectMisses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds,
      candidateDeviceIds,
      succeededPlatforms: succeededPlatforms as Set<"android" | "ios">,
      candidatePlatforms: candidatePlatforms as Map<string, "android" | "ios">,
      candidateIncarnations,
      deviceDisconnectMissIncarnations,
    });
  };

  test("resets miss count when device appears in booted list", () => {
    const misses = new Map<string, number>();
    misses.set("device-1", 2);

    runDisconnectPoll(misses, new Set(["device-1"]), new Set(["device-1"]));
    expect(misses.has("device-1")).toBe(false);
  });

  // These three exercise the miss-counting mechanism itself. They simulate an
  // Android device ("ADB returning some devices but not ours"), so they name
  // its platform: a candidate with no platform at all is unverifiable by
  // construction and is deliberately never aged out (see below).
  const ANDROID_CANDIDATE = new Map([["device-1", "android"]]);
  const ANDROID_SUCCEEDED = new Set(["android"]);

  test("increments miss count when device is absent", () => {
    const misses = new Map<string, number>();

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
    const misses = new Map<string, number>();

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
    const misses = new Map<string, number>();

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
    const misses = new Map<string, number>();

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
    const misses = new Map<string, number>();

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

  test("retains candidates without misses when all platform discovery fails", () => {
    const misses = new Map<string, number>([["device-1", 2]]);

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["device-1"]),
      new Set(),
      new Map([["device-1", "android"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(true);
    expect(result.disconnected).toEqual([]);
    expect(misses.has("device-1")).toBe(false);
  });

  test("miss-counts only candidates whose platform discovery succeeds", () => {
    const misses = new Map<string, number>();

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
    const misses = new Map<string, number>();
    const forced = new Set(["emulator-5554"]);
    const input = {
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set(),
      forceDisconnectedDeviceIds: forced,
      bootedDeviceIds: new Set(),
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
    const misses = new Map([["emulator-5554", 1]]);
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
    expect(misses.has("emulator-5554")).toBe(false);
  });

  test("fresh booted scan clears a stale forced missing flag", () => {
    const forceDisconnectedDeviceIds = new Set(["emulator-5554"]);
    const result = evaluateDeviceDisconnects({
      deviceDisconnectMisses: new Map(),
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
    const misses = new Map<string, number>();
    const forced = new Set<string>();
    const generations = new Map<string, number>();
    const daemon = {
      devicePool: { getDevice: () => ({}) },
      sessionManager: { getSessionForDevice: () => null },
      deviceDisconnectMisses: misses,
      forceDisconnectedDeviceIds: forced,
      forceDisconnectedDeviceGenerations: generations,
      unsubscribeAdbMissingDevice: null as (() => void) | null,
    };
    const startAdbMissingDeviceListener = (
      Daemon.prototype as unknown as { startAdbMissingDeviceListener: () => void }
    ).startAdbMissingDeviceListener;

    startAdbMissingDeviceListener.call(daemon);
    try {
      notifyAdbMissingDevice("emulator-5554", new Error("device 'emulator-5554' not found"));
      expect(forced.has("emulator-5554")).toBe(true);
      expect(generations.get("emulator-5554")).toBe(1);
      expect(misses.has("emulator-5554")).toBe(false);
    } finally {
      daemon.unsubscribeAdbMissingDevice?.();
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
      const pooledDevice = { incarnation: 1 };
      const daemon = {
        devicePool: {
          getDevice: () => pooledDevice,
          isShutdownReserved: async () => false,
        },
        sessionManager: { getSessionForDevice: () => null },
        forceDisconnectedDeviceIds: new Set<string>(),
        forceDisconnectedDeviceGenerations: new Map<string, number>(),
        unsubscribeAdbMissingDevice: null as (() => void) | null,
      };
      const start = (Daemon.prototype as unknown as { startAdbMissingDeviceListener(): void })
        .startAdbMissingDeviceListener;
      start.call(daemon);
      const screen = new FakeObserveScreen();
      screen.setObserveResult((index) => {
        if (index === 1) {
          notifyAdbMissingDevice(
            "emulator-5554",
            new Error("adb: device 'emulator-5554' not found"),
          );
          const confirmation = evaluateDeviceDisconnects({
            deviceDisconnectMisses: new Map(),
            confirmedDisconnectedDeviceIds: new Set(),
            forceDisconnectedDeviceIds: daemon.forceDisconnectedDeviceIds,
            bootedDeviceIds: new Set(["emulator-5554"]),
            candidateDeviceIds: new Set(["emulator-5554"]),
            succeededPlatforms: new Set(["android"]),
            candidatePlatforms: new Map([["emulator-5554", "android"]]),
          });
          expect(confirmation.disconnected).toEqual([]);
        }
        return {
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
        const outcome = await waitForObservation(
          screen,
          waitFor,
          tracked.abortController.signal,
          false,
          timer,
        );
        expect(outcome.matched).toBe(true);
        expect(outcome.timedOut).toBe(false);
        expect(screen.getExecuteCallCount()).toBe(3);
        expect(tracked.abortController.signal.aborted).toBe(false);
        expect(tracked.cancelReason).toBeUndefined();
        expect(daemon.forceDisconnectedDeviceIds.size).toBe(0);
      } finally {
        daemon.unsubscribeAdbMissingDevice?.();
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
    const daemon = {
      devicePool: {
        getDevice: () => ({ incarnation: 1, status: "booting" }),
        isShutdownReserved: shutdownCheck,
      },
      sessionManager: { getSessionForDevice: () => "plan-session" },
      forceDisconnectedDeviceIds: new Set<string>(),
      forceDisconnectedDeviceGenerations: new Map<string, number>(),
      unsubscribeAdbMissingDevice: null as (() => void) | null,
    };
    const start = (Daemon.prototype as unknown as { startAdbMissingDeviceListener(): void })
      .startAdbMissingDeviceListener;
    start.call(daemon);
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
      expect(daemon.forceDisconnectedDeviceIds).toEqual(new Set(["emulator-5554"]));
    } finally {
      daemon.unsubscribeAdbMissingDevice?.();
      for (const execution of [tracked, recovery, otherClient, otherDevice]) {
        executionTracker.endExecution(execution.id);
      }
      cancel.mockRestore();
      planActive.mockRestore();
    }
  });

  test("skips candidates from platforms whose discovery did not succeed", () => {
    const misses = new Map<string, number>();
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
    expect(misses.has("sim-1")).toBe(false);
  });

  test("miss-counts a device once its platform discovery succeeds", () => {
    const misses = new Map<string, number>();

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
    const misses = new Map<string, number>();
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
    const misses = new Map<string, number>([["sim-1", 2]]);
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
    const misses = new Map<string, number>([["sim-1", 2]]);
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
    const misses = new Map<string, number>([["sim-1", 2]]);
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
      deviceDisconnectMisses: new Map(),
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
    const misses = new Map<string, number>();

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
    const misses = new Map<string, number>();
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
    const misses = new Map<string, number>();

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

  test("clears disconnect state when an absent candidate is pooled before cleanup", async () => {
    const misses = new Map([["sim-1", DEVICE_DISCONNECT_MISS_THRESHOLD]]);
    const missIncarnations = new Map([["sim-1", 1]]);
    const confirmed = new Set(["sim-1"]);
    const forced = new Set(["sim-1"]);
    const daemon = {
      devicePool: {
        getDevice: () => ({}),
      },
      deviceDisconnectMisses: misses,
      deviceDisconnectMissIncarnations: missIncarnations,
      confirmedDisconnectedDeviceIds: confirmed,
      forceDisconnectedDeviceIds: forced,
      forceDisconnectedDeviceGenerations: new Map(),
    };
    const shouldSkipStaleDisconnectCleanup = (
      Daemon.prototype as unknown as {
        shouldSkipStaleDisconnectCleanup: (
          pooledDeviceAtDisconnect: null,
          deviceId: string,
        ) => Promise<boolean>;
      }
    ).shouldSkipStaleDisconnectCleanup;

    await expect(shouldSkipStaleDisconnectCleanup.call(daemon, null, "sim-1")).resolves.toBe(true);
    expect(misses.has("sim-1")).toBe(false);
    expect(missIncarnations.has("sim-1")).toBe(false);
    expect(confirmed.has("sim-1")).toBe(false);
    expect(forced.has("sim-1")).toBe(false);
  });

  test("retains a replacement force marker when null-captured cleanup finds a pooled device", async () => {
    const forced = new Set(["sim-1"]);
    const forceGenerations = new Map([["sim-1", 2]]);
    const daemon = {
      devicePool: {
        getDevice: () => ({}),
      },
      deviceDisconnectMisses: new Map([["sim-1", DEVICE_DISCONNECT_MISS_THRESHOLD]]),
      deviceDisconnectMissIncarnations: new Map([["sim-1", 1]]),
      confirmedDisconnectedDeviceIds: new Set(["sim-1"]),
      forceDisconnectedDeviceIds: forced,
      forceDisconnectedDeviceGenerations: forceGenerations,
    };
    const shouldSkipStaleDisconnectCleanup = (
      Daemon.prototype as unknown as {
        shouldSkipStaleDisconnectCleanup: (
          pooledDeviceAtDisconnect: null,
          deviceId: string,
          forceGenerationAtDisconnect: number | undefined,
        ) => Promise<boolean>;
      }
    ).shouldSkipStaleDisconnectCleanup;

    await expect(shouldSkipStaleDisconnectCleanup.call(daemon, null, "sim-1", 1)).resolves.toBe(
      true,
    );
    expect(forced.has("sim-1")).toBe(true);
    expect(forceGenerations.get("sim-1")).toBe(2);
  });

  test("clears disconnect state when cleanup rediscovers the pooled incarnation", async () => {
    const misses = new Map([["emulator-5554", DEVICE_DISCONNECT_MISS_THRESHOLD]]);
    const missIncarnations = new Map([["emulator-5554", 4]]);
    const daemon = {
      devicePool: {
        isCurrentDisconnectedDevice: async () => "recovered" as const,
      },
      deviceDisconnectMisses: misses,
      deviceDisconnectMissIncarnations: missIncarnations,
      confirmedDisconnectedDeviceIds: new Set(["emulator-5554"]),
      forceDisconnectedDeviceIds: new Set(["emulator-5554"]),
      forceDisconnectedDeviceGenerations: new Map([["emulator-5554", 1]]),
    };
    const shouldSkipStaleDisconnectCleanup = (
      Daemon.prototype as unknown as {
        shouldSkipStaleDisconnectCleanup: (
          pooledDeviceAtDisconnect: object,
          deviceId: string,
        ) => Promise<boolean>;
      }
    ).shouldSkipStaleDisconnectCleanup;

    await expect(shouldSkipStaleDisconnectCleanup.call(daemon, {}, "emulator-5554")).resolves.toBe(
      true,
    );
    expect(misses.has("emulator-5554")).toBe(false);
    expect(missIncarnations.has("emulator-5554")).toBe(false);
    expect(daemon.confirmedDisconnectedDeviceIds.has("emulator-5554")).toBe(false);
    expect(daemon.forceDisconnectedDeviceIds.has("emulator-5554")).toBe(false);
  });

  test("preserves a force signal raised during recovery verification", async () => {
    let resolveVerification: (() => void) | undefined;
    const verification = new Promise<void>((resolve) => {
      resolveVerification = resolve;
    });
    const forced = new Set<string>();
    const forceGenerations = new Map<string, number>();
    const daemon = {
      devicePool: {
        isCurrentDisconnectedDevice: async () => {
          await verification;
          return "recovered" as const;
        },
      },
      deviceDisconnectMisses: new Map([["emulator-5554", DEVICE_DISCONNECT_MISS_THRESHOLD]]),
      deviceDisconnectMissIncarnations: new Map([["emulator-5554", 4]]),
      confirmedDisconnectedDeviceIds: new Set(["emulator-5554"]),
      forceDisconnectedDeviceIds: forced,
      forceDisconnectedDeviceGenerations: forceGenerations,
    };
    const shouldSkipStaleDisconnectCleanup = (
      Daemon.prototype as unknown as {
        shouldSkipStaleDisconnectCleanup: (
          pooledDeviceAtDisconnect: object,
          deviceId: string,
        ) => Promise<boolean>;
      }
    ).shouldSkipStaleDisconnectCleanup;

    const pending = shouldSkipStaleDisconnectCleanup.call(daemon, {}, "emulator-5554");
    forced.add("emulator-5554");
    forceGenerations.set("emulator-5554", 1);
    resolveVerification?.();

    await expect(pending).resolves.toBe(true);
    expect(forced.has("emulator-5554")).toBe(true);
    expect(forceGenerations.get("emulator-5554")).toBe(1);
  });

  test("rejects an old disconnect target after cancellation races a same-ID replacement", () => {
    const capturedDevice = { assignmentCount: 4 };
    const replacementDevice = { assignmentCount: 1 };
    const daemon = {
      devicePool: {
        getDevice: () => replacementDevice,
      },
      sessionManager: {
        getSessionForDevice: () => null,
      },
    };
    const isCapturedDisconnectTargetCurrent = (
      Daemon.prototype as unknown as {
        isCapturedDisconnectTargetCurrent: (
          deviceId: string,
          pooledDeviceAtDisconnect: object,
          assignmentCountAtDisconnect: number,
        ) => boolean;
      }
    ).isCapturedDisconnectTargetCurrent;

    expect(isCapturedDisconnectTargetCurrent.call(daemon, "emulator-5554", capturedDevice, 4)).toBe(
      false,
    );
  });

  test("retains disconnect state when cleanup verification is inconclusive", async () => {
    const misses = new Map([["emulator-5554", DEVICE_DISCONNECT_MISS_THRESHOLD]]);
    const missIncarnations = new Map([["emulator-5554", 4]]);
    const daemon = {
      devicePool: {
        isCurrentDisconnectedDevice: async () => "unknown" as const,
      },
      deviceDisconnectMisses: misses,
      deviceDisconnectMissIncarnations: missIncarnations,
      confirmedDisconnectedDeviceIds: new Set(["emulator-5554"]),
      forceDisconnectedDeviceIds: new Set(["emulator-5554"]),
      forceDisconnectedDeviceGenerations: new Map([["emulator-5554", 1]]),
    };
    const shouldSkipStaleDisconnectCleanup = (
      Daemon.prototype as unknown as {
        shouldSkipStaleDisconnectCleanup: (
          pooledDeviceAtDisconnect: object,
          deviceId: string,
        ) => Promise<boolean>;
      }
    ).shouldSkipStaleDisconnectCleanup;

    await expect(shouldSkipStaleDisconnectCleanup.call(daemon, {}, "emulator-5554")).resolves.toBe(
      true,
    );
    expect(misses.get("emulator-5554")).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD);
    expect(missIncarnations.get("emulator-5554")).toBe(4);
    expect(daemon.confirmedDisconnectedDeviceIds.has("emulator-5554")).toBe(true);
    expect(daemon.forceDisconnectedDeviceIds.has("emulator-5554")).toBe(true);
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
