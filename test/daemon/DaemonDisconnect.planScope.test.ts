import { afterEach, describe, expect, test } from "bun:test";
import { executionTracker } from "../../src/daemon/executionTracker";
import {
  DEVICE_DISCONNECT_MISS_THRESHOLD,
  PLAN_DEVICE_DISCONNECT_MISS_CAP,
} from "../../src/daemon/deviceLossDiscovery";
import { PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS } from "../../src/daemon/planDeviceLossMonitor";
import type { Session } from "../../src/daemon/sessionManager";
import type { SomePlatform } from "../../src/models";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { createPooledDevice, DaemonDisconnectHarness } from "./helpers/DaemonDisconnectHarness";

const previousPlanActive = serverConfig.isPlanExecutionActive();
const executions: string[] = [];
afterEach(() => {
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
    override async getBootedDevicesDetailed(requested: SomePlatform) {
      this.platforms.push(requested);
      return super.getBootedDevicesDetailed(requested);
    }
    async getAndroidOfflineDeviceIds() {
      this.offlineProbes++;
      return new Set<string>();
    }
    async recoverAndroidOfflineDevices() {}
  }
  const manager = new Manager([], [{ deviceId: peer.id, platform: "android", name: "peer" }]);
  daemon.startMonitor(manager, async () => []);
  return {
    daemon,
    device,
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
    h.manager.androidListedDeviceStates.set(h.device.id, "offline");
    try {
      for (let n = 0; n < DEVICE_DISCONNECT_MISS_THRESHOLD; n++) {
        await h.tick();
      }
      expect(h.losses).toEqual([]);
      expect(h.released).toEqual([]);
      expect(h.daemon.disconnectMisses.has(h.device.id)).toBe(false);
    } finally {
      await h.daemon.disconnectMonitor?.stop();
    }
  });

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
