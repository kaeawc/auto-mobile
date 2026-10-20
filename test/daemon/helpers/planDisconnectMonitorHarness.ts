import { executionTracker } from "../../../src/daemon/executionTracker";
import {
  DaemonDisconnectHarness,
  createPooledDevice,
  type MutablePooledDevice,
} from "./DaemonDisconnectHarness";
import { createFakeSession } from "./inputSocketHarness";
import type { VideoRecordingRecord } from "../../../src/db/videoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../../src/features/video";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { InMemoryAdbTransportRestartRegistry } from "../../../src/utils/android-cmdline-tools/AdbTransportRestartRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
const DEVICE_DISCONNECT_POLL_INTERVAL_MS = 5000;

function recordingsFor(
  device: Pick<MutablePooledDevice, "id" | "platform">,
): VideoRecordingRecord[] {
  return [
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
}

export function planDisconnectMonitorHarness(deviceId = "emulator-5554") {
  const timer = new FakeTimer();
  const actions: string[] = [];
  const device: MutablePooledDevice = createPooledDevice(deviceId, {
    sessionId: "plan-session",
    status: "busy",
    avdName: "Pixel",
    androidImage: { name: "Pixel", platform: "android", isRunning: true },
  });
  let pooled = true;
  let startupLeased = false;
  let planId: string | undefined;
  let sessionActive = true;
  const session = createFakeSession(device.sessionId ?? "", device.id, "android");
  const devices: MutablePooledDevice[] = [device];
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
  const recordings = recordingsFor(device);
  // Exercise the real daemon tick over a real (fake-backed) daemon, replacing only the pool and
  // session-manager reads and the steps the tick hands off to other subsystems.
  const daemon = new DaemonDisconnectHarness(timer, {
    shouldSkipStaleDisconnectCleanup: async () => false,
    recordAndTryRecoverCapturedDisconnect: async () => {
      actions.push("device-loss-recovery");
      return { incidentId: undefined, handled: false };
    },
    cancelAndReleaseSession: async (id: string) => {
      actions.push(`cancel:${id}`);
      sessionActive = false;
      return true;
    },
    stopRecordingAfterDeviceDisconnect: async () => {
      actions.push("stop-recording");
      return true;
    },
  });
  const pool = daemon.getDevicePool();
  pool.retryDueDeferredSessionRecoveries = async (mayRecover = () => true) => {
    if (devices.some((device) => mayRecover(device.id))) {
      actions.push("deferred-recovery");
    }
  };
  pool.reconcileDiscoveryObservation = async () => {
    actions.push("reconcile");
  };
  pool.mapAndroidDiscovery = (discovered) => [...discovered];
  pool.getAndroidTransportAliases = (): string[] => [];
  pool.getAllDevices = () => (pooled ? devices : []);
  pool.getDevice = (id: string) => (pooled && id === device.id ? device : null);
  pool.isDeviceLeasedForAndroidStartup = () => startupLeased;
  pool.recordEmulatorLossIncident = async () => undefined;
  pool.finishEmulatorLossIncident = async () => {};
  pool.detachAdbServerResetCohort = async () => {
    actions.push("detach-reset-cohort");
    return { devices: [], deferred: false };
  };
  pool.releaseAdbServerResetCohortReservations = async () => {
    actions.push("release-reset-cohort");
  };
  pool.removeDisconnectedDevice = async (id: string) => {
    actions.push(`remove:${id}`);
    pooled = false;
  };
  const sessions = daemon.getSessionManager();
  sessions.getAllSessions = () => (sessionActive ? [session] : []);
  sessions.getSessionForDevice = () => (sessionActive ? session.sessionId : null);
  sessions.getSession = () => (sessionActive ? session : null);
  const recordingsReader = {
    calls: 0,
    async list() {
      this.calls++;
      return recordings;
    },
  };
  const transportRestarts = new InMemoryAdbTransportRestartRegistry(timer);
  daemon.startMonitor(manager, () => recordingsReader.list(), transportRestarts);
  return {
    daemon,
    transportRestarts,
    manager,
    device,
    devices,
    timer,
    actions,
    recordingsReader,
    beginPlanRestart(deviceIds = [device.id]) {
      const execution = executionTracker.startExecution("executePlan", undefined, "plan-session");
      planId = execution.id;
      for (const id of deviceIds) {
        executionTracker.bindDeviceExecution(execution.id, id);
      }
      startupLeased = true;
    },
    endPlanRestart() {
      if (planId) {
        executionTracker.endExecution(planId);
      }
      startupLeased = false;
    },
    /** The device returns and a new owner acquires it under a fresh incarnation. */
    replug(sessionId: string) {
      pooled = true;
      sessionActive = true;
      session.sessionId = sessionId;
      device.sessionId = sessionId;
      device.incarnation++;
      device.assignmentCount++;
      manager.bootedDevices = [{ deviceId: device.id, name: "Pixel", platform: "android" }];
    },
    async tick() {
      timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
      // run() joins the tick just fired by FakeTimer; it does not start another.
      await daemon.disconnectMonitor?.run();
    },
  };
}
