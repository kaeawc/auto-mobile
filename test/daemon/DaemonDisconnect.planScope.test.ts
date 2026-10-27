import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PlanExecutionOrchestrator } from "../../src/server/planExecutionOrchestrator";
import * as planUtils from "../../src/server/planExecutorFactory";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { executionTracker } from "../../src/daemon/executionTracker";
import {
  DEVICE_DISCONNECT_MISS_THRESHOLD,
  PLAN_DEVICE_DISCONNECT_MISS_CAP,
} from "../../src/daemon/deviceLossDiscovery";
import { PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS } from "../../src/daemon/planDeviceLossMonitor";
import type { Session } from "../../src/daemon/sessionManager";
import type { SomePlatform } from "../../src/models";
import { serverConfig, type PlanExecutionLease } from "../../src/utils/ServerConfig";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { createPooledDevice, DaemonDisconnectHarness } from "./helpers/DaemonDisconnectHarness";

const previousPlanActive = serverConfig.isPlanExecutionActive();
const executions: string[] = [];
const leases: PlanExecutionLease[] = [];
afterEach(() => {
  for (const lease of leases.splice(0)) {
    lease.release();
  }
  for (const id of executions.splice(0)) {
    executionTracker.endExecution(id);
  }
  serverConfig.setPlanExecutionActive(previousPlanActive);
});

function startPlan(deviceId: string, sessionUuid: string) {
  const execution = executionTracker.startExecution("executePlan", undefined, sessionUuid);
  executions.push(execution.id);
  executionTracker.bindDeviceExecution(execution.id, deviceId);
  return execution;
}

function startLeasedPlan(deviceId: string, sessionUuid: string) {
  const execution = executionTracker.startExecution("executePlan", undefined, sessionUuid);
  executions.push(execution.id);
  const lease = serverConfig.acquirePlanExecutionLease({
    deviceId,
    sessionUuid,
    executionId: execution.id,
  });
  leases.push(lease);
  return { execution, lease };
}

function harness(platform: "android" | "ios" = "ios") {
  serverConfig.setPlanExecutionActive(true);
  const timer = new FakeTimer();
  const released: string[] = [];
  const losses: string[] = [];
  const device = createPooledDevice(
    platform === "ios" ? "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" : "emulator-5554",
    { platform, status: "busy", sessionId: "holder" },
  );
  const peer = createPooledDevice("emulator-5556", { status: "busy", sessionId: "peer" });
  const devices = new Map([
    [device.id, device],
    [peer.id, peer],
  ]);
  const session: Session = {
    sessionId: "holder",
    assignedDevice: device.id,
    platform,
    createdAt: 0,
    lastUsedAt: 0,
    activityGeneration: 0,
    expiresAt: 1_000_000,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 1_000_000,
    heartbeatTimeoutMs: 1_000_000,
    heartbeatTimeoutSource: "custom",
    hasReceivedHeartbeat: true,
    ownership: "owned",
    livenessPolicy: "heartbeat",
  };
  const daemon = new DaemonDisconnectHarness(timer, {
    shouldSkipStaleDisconnectCleanup: async () => false,
    recordAndTryRecoverCapturedDisconnect: async () => {
      losses.push(device.id);
      return { incidentId: undefined, handled: false };
    },
    cancelAndReleaseSession: async (id) => {
      released.push(id);
      return true;
    },
  });
  const pool = daemon.getDevicePool();
  pool.getAllDevices = () => [...devices.values()];
  pool.getDevice = (id) => devices.get(id) ?? null;
  pool.reconcileDiscoveryObservation = async () => {};
  pool.isShutdownReservationHeld = async () => false;
  pool.recordEmulatorLossIncident = async (id) => {
    losses.push(id);
    return undefined;
  };
  pool.finishEmulatorLossIncident = async () => {};
  pool.removeDisconnectedDevice = async (id) => {
    devices.delete(id);
  };
  const sessions = daemon.getSessionManager();
  sessions.getAllSessions = () => [session];
  sessions.getSession = (id) => (id === session.sessionId ? session : null);
  sessions.getSessionForDevice = (id) =>
    id === device.id && released.length > 0 ? null : (devices.get(id)?.sessionId ?? null);
  class Manager extends FakeDeviceManager {
    platforms: SomePlatform[] = [];
    offlineProbes = 0;
    reconnects: string[][] = [];
    override async getBootedDevicesDetailed(requested: SomePlatform) {
      this.platforms.push(requested);
      return super.getBootedDevicesDetailed(requested);
    }
    async getAndroidOfflineDeviceIds() {
      this.offlineProbes++;
      return new Set<string>();
    }
    async recoverAndroidOfflineDevices(ids: Iterable<string>) {
      this.reconnects.push([...ids]);
    }
  }
  const manager = new Manager([], [{ deviceId: peer.id, platform: "android", name: "peer" }]);
  daemon.startMonitor(manager, async () => []);
  return {
    daemon,
    device,
    session,
    devices,
    peer,
    manager,
    losses,
    released,
    timer,
    async tick() {
      timer.setCurrentTime(timer.now() + PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
      await daemon.disconnectMonitor?.run();
    },
  };
}

describe("DaemonDisconnect per-device plan deferral", () => {
  test("an ADB reset cohort with only one planned device defers every member", async () => {
    const h = harness("android");
    for (const device of h.devices.values()) {
      device.avdName = device.id;
      device.androidImage = { name: device.id, platform: "android", isRunning: true };
    }
    startPlan(h.device.id, "holder");
    h.manager.bootedDevices = [];
    h.daemon.forcedDisconnected = new Set([h.device.id]);
    const detached: string[][] = [];
    h.daemon.getDevicePool().detachAdbServerResetCohort = async (devices) => {
      detached.push(devices.map(({ id }) => id));
      return { devices: [], deferred: false };
    };
    try {
      for (let n = 0; n < DEVICE_DISCONNECT_MISS_THRESHOLD + 1; n++) {
        await h.tick();
      }
      expect(h.daemon.disconnectMisses.get(h.peer.id)).toBeGreaterThanOrEqual(
        DEVICE_DISCONNECT_MISS_THRESHOLD,
      );
      expect(detached).toEqual([]);
      expect(h.losses).toEqual([]);
      expect(h.released).toEqual([]);
      expect(h.daemon.confirmedDisconnected.size).toBe(0);
      expect(h.devices.size).toBe(2);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("a revoked leased plan can reappear and vanish again while draining", async () => {
    const h = harness();
    const { execution } = startLeasedPlan(h.device.id, "holder");
    const finished: Array<string | undefined> = [];
    h.daemon.getDevicePool().recordEmulatorLossIncident = async (id) => {
      h.losses.push(id);
      return `incident-${h.losses.length}`;
    };
    h.daemon.getDevicePool().finishEmulatorLossIncident = async (id) => {
      finished.push(id);
    };
    try {
      await h.tick();
      await h.tick();
      expect(execution.abortController.signal.aborted).toBe(true);
      h.manager.bootedDevices.push({ deviceId: h.device.id, platform: "ios", name: "iPhone" });
      await h.tick();
      h.manager.bootedDevices = [];
      await h.tick();
      await h.tick();
      expect(h.losses).toEqual([h.device.id, h.device.id]);
      expect(finished).toEqual(["incident-1", "incident-2"]);
      expect(h.released).toEqual([]);
      expect(h.timer.getSleepHistory()).toEqual([]);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("a new lease in the same session re-arms loss without a presence tick", async () => {
    const h = harness();
    const first = startLeasedPlan(h.device.id, "holder");
    try {
      await h.tick();
      await h.tick();
      expect(first.execution.abortController.signal.aborted).toBe(true);
      await h.tick();
      expect(h.losses).toHaveLength(1);
      first.lease.release();
      executionTracker.endExecution(first.execution.id);
      const next = startLeasedPlan(h.device.id, "holder");
      await h.tick();
      expect(next.execution.abortController.signal.aborted).toBe(false);
      await h.tick();
      expect(next.execution.abortController.signal.aborted).toBe(true);
      await h.tick();
      expect(h.losses).toEqual([h.device.id, h.device.id]);
      expect(h.released).toEqual([]);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("a lease acquired during the listed-state probe protects the device in the same sweep", async () => {
    const h = harness("android");
    let lease: PlanExecutionLease | undefined;
    h.daemon.disconnectMisses.set(h.device.id, DEVICE_DISCONNECT_MISS_THRESHOLD - 1);
    h.manager.getAndroidListedDeviceStates = async () => {
      lease = serverConfig.acquirePlanExecutionLease({
        sessionUuid: "holder",
        deviceId: h.device.id,
      });
      return new Map();
    };
    try {
      await h.tick();
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(PLAN_DEVICE_DISCONNECT_MISS_CAP);
      expect(h.losses).toEqual([]);
      expect(h.released).toEqual([]);
    } finally {
      lease?.release();
      await h.daemon.disconnectMonitor?.stop();
    }
  });
  test("a nested label's loss reaches plan-time confirmation (#14445)", async () => {
    const h = harness();
    // An external plan on derived session base:B allocated nested label base:B:C on this device.
    h.session.sessionId = "base:B:C";
    h.device.sessionId = "base:B:C";
    const labels: Record<string, Record<string, string>> = {
      base: { A: "base", B: "base:B" },
      "base:B": { A: "base:B", C: "base:B:C" },
    };
    h.daemon.getSessionManager().getDeviceLabels = (id) => labels[id];
    const execution = executionTracker.startExecution("executePlan", undefined, "base:B");
    executions.push(execution.id);
    leases.push(
      serverConfig.acquirePlanExecutionLease({
        sessionUuid: "base:B",
        deviceId: "primary-device",
        executionId: execution.id,
        labelSessionUuids: ["base:B", "base:B:C"],
      }),
    );
    try {
      await h.tick();
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(PLAN_DEVICE_DISCONNECT_MISS_CAP);
      await h.tick();
      expect(h.losses).toEqual([h.device.id]);
      expect(h.released).toEqual([]);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("a plan recorded under its derived label is cancelled on confirmed loss (#14443)", async () => {
    const h = harness();
    // executePlan routed through base:B: ingress records the execution under base:B, while the
    // loss monitor holds the base:B holder as its owner base.
    h.session.sessionId = "base:B";
    h.device.sessionId = "base:B";
    h.daemon.getSessionManager().getDeviceLabels = (id) =>
      id === "base" ? { A: "base", B: "base:B" } : undefined;
    const { execution } = startLeasedPlan(h.device.id, "base:B");
    const bystander = startPlan(h.device.id, "base:other");
    try {
      await h.tick();
      expect(execution.abortController.signal.aborted).toBe(false);
      await h.tick();
      expect(h.losses).toEqual([h.device.id]);
      expect(execution.abortController.signal.aborted).toBe(true);
      expect(bystander.abortController.signal.aborted).toBe(false);
      expect(h.released).toEqual([]);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("an unrelated plan does not hold deferred iOS recovery", async () => {
    const h = harness();
    startPlan(h.peer.id, "peer");
    const recoveries: string[] = [];
    h.daemon.getDevicePool().retryDueDeferredSessionRecoveries = async (
      mayRecover = () => true,
    ) => {
      for (const id of [h.device.id, h.peer.id]) {
        if (mayRecover(id)) {
          recoveries.push(id);
        }
      }
    };
    try {
      await h.tick();
      expect(recoveries).toEqual([h.device.id]);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("an iOS plan does not block an unrelated Android reset cohort", async () => {
    const h = harness();
    startPlan(h.device.id, "holder");
    const cohort = ["emulator-5560", "emulator-5562"].map((id) =>
      createPooledDevice(id, {
        avdName: id,
        androidImage: { name: id, platform: "android", isRunning: true },
      }),
    );
    for (const device of cohort) {
      h.devices.set(device.id, device);
    }
    h.daemon.forcedDisconnected = new Set([cohort[0].id]);
    const detached: string[][] = [];
    h.daemon.getDevicePool().detachAdbServerResetCohort = async (devices) => {
      detached.push(devices.map((device) => device.id));
      return { devices: [], deferred: false };
    };
    try {
      await h.tick();
      expect(detached).toEqual([cohort.map((device) => device.id)]);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });
  test.each(["android", "ios"] as const)(
    "%s without a plan reaches disconnect handling while an unrelated plan runs",
    async (platform) => {
      const h = harness(platform);
      const peerPlan = startPlan(h.peer.id, "peer");
      try {
        await h.tick();
        await h.tick();
        for (let n = 2; n < DEVICE_DISCONNECT_MISS_THRESHOLD; n++) {
          await h.tick();
        }
        expect(h.losses).toEqual([h.device.id]);
        expect(h.released).toEqual(["holder"]);
        expect(h.daemon.confirmedDisconnected.has(h.device.id)).toBe(true);
        expect(peerPlan.abortController.signal.aborted).toBe(false);
      } finally {
        await h.daemon.disconnectMonitor?.stop();
      }
    },
  );

  test("another device's plan does not clamp a device without plan work", async () => {
    const h = harness();
    startPlan(h.peer.id, "peer");
    try {
      await h.tick();
      await h.tick();
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(2);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("an unrelated plan does not remove ordinary Android offline protection", async () => {
    const h = harness("android");
    startPlan(h.peer.id, "peer");
    h.daemon.getDevicePool().isDeviceLeasedForAndroidStartup = (id) => id === h.peer.id;
    h.daemon.offlineRecoveryAttempted.add(h.peer.id);
    h.daemon.offlineRecoveryIncarnations.set(h.peer.id, h.peer.incarnation);
    h.manager.androidListedDeviceStates.set(h.device.id, "offline");
    try {
      for (let n = 0; n < DEVICE_DISCONNECT_MISS_THRESHOLD; n++) {
        await h.tick();
      }
      expect(h.losses).toEqual([]);
      expect(h.released).toEqual([]);
      expect(h.daemon.disconnectMisses.has(h.device.id)).toBe(false);
      expect(h.manager.reconnects).toEqual([[h.device.id]]);
      expect(h.daemon.offlineRecoveryAttempted.has(h.peer.id)).toBe(true);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test.each(["android", "ios"] as const)(
    "%s orchestrator lease protects and cancels its device before any adb binding",
    async (platform) => {
      const h = harness(platform);
      const execution = executionTracker.startExecution("executePlan", undefined, "holder");
      executions.push(execution.id);
      const recordingStarted = Promise.withResolvers<void>();
      const unblockRecording = Promise.withResolvers<void>();
      const execute = spyOn(planUtils, "executePlan").mockImplementation(() => {
        execution.abortController.signal.throwIfAborted();
        return Promise.resolve({ success: true, executedSteps: 1, totalSteps: 1 });
      });
      const run = runWithToolSelectionContext(
        { execution: { executionId: execution.id, startTime: execution.startTime } },
        () =>
          new PlanExecutionOrchestrator(
            {
              device: { deviceId: h.device.id, platform, name: "simulator" },
              request: {
                planContent: "name: lease-ingress\nsteps:\n  - tool: observe\n    params: {}\n",
                startStep: 0,
                platform,
                sessionUuid: "holder",
                deviceAllocationTimeoutMs: 5000,
              },
              signal: execution.abortController.signal,
            },
            {
              timer: h.timer,
              createSchemaValidator: () => ({
                loadSchema: async () => undefined,
                validateYaml: () => ({ valid: true }),
              }),
              videoRecorder: {
                startVideoRecording: async () => {
                  recordingStarted.resolve();
                  await unblockRecording.promise;
                  throw new Error("recording unavailable");
                },
                stopVideoRecording: async () => {
                  throw new Error("no recording started");
                },
              },
            },
          ).execute(),
      );
      const outcome = run.catch((error: unknown) => error);
      try {
        await recordingStarted.promise;
        expect(executionTracker.hasActiveDeviceExecutions(h.device.id)).toBe(false);
        await h.tick();
        expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(PLAN_DEVICE_DISCONNECT_MISS_CAP);
        expect(h.losses).toEqual([]);
        await h.tick();
        expect(h.losses).toEqual([h.device.id]);
        expect(execution.abortController.signal.aborted).toBe(true);
        expect(h.released).toEqual([]);
        unblockRecording.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        executionTracker.endExecution(execution.id);
        await h.tick();
        await h.tick();
        expect(h.released).toEqual(["holder"]);
      } finally {
        unblockRecording.resolve();
        await outcome;
        execute.mockRestore();
        await h.daemon.disconnectMonitor?.stop();
      }
    },
  );

  test("Android with its own plan retains the capped miss grace", async () => {
    const h = harness("android");
    const plan = startPlan(h.device.id, "holder");
    h.manager.androidListedDeviceStates.set(h.device.id, "offline");
    h.manager.getAndroidOfflineDeviceIds = async () => new Set([h.device.id]);
    try {
      for (let n = 0; n < 5; n++) {
        await h.tick();
      }
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(PLAN_DEVICE_DISCONNECT_MISS_CAP);
      expect(h.released).toEqual([]);
      expect(plan.abortController.signal.aborted).toBe(false);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

  test("iOS with its own plan confirms via simctl, cancels, then releases after plan settlement", async () => {
    const h = harness();
    const plan = startPlan(h.device.id, "holder");
    try {
      await h.tick();
      expect(plan.abortController.signal.aborted).toBe(false);
      expect(h.losses).toEqual([]);
      await h.tick();
      expect(plan.abortController.signal.aborted).toBe(true);
      expect(h.losses).toEqual([h.device.id]);
      expect(h.released).toEqual([]);
      expect(h.manager.platforms).toEqual(["either", "ios", "either", "ios"]);
      expect(h.manager.offlineProbes).toBe(0);
      executionTracker.endExecution(plan.id);
      for (let n = 0; n < DEVICE_DISCONNECT_MISS_THRESHOLD - PLAN_DEVICE_DISCONNECT_MISS_CAP; n++) {
        await h.tick();
      }
      expect(h.released).toEqual(["holder"]);
      expect(h.daemon.confirmedDisconnected.has(h.device.id)).toBe(true);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });
});
