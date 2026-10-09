import { describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import {
  evaluateDeviceDisconnects,
  OFFLINE_DEVICE_DISCONNECT_BUDGET_MS,
  type OfflineEpisode,
} from "../../src/daemon/disconnectMonitor";
import type { BootedDevice, ExecResult, Platform } from "../../src/models";
import { AdbClient, resetAdbClientCaches } from "../../src/utils/android-cmdline-tools/AdbClient";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";

const EMULATOR = "emulator-5554";
const POLL_MS = 5_000;

// `adb devices -l` rows in the shape adb prints them (#11090).
const ROWS = {
  device: `${EMULATOR}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1`,
  offline: `${EMULATOR}          offline transport_id:1`,
};

/**
 * Daemon disconnect monitor over one session-bound emulator. Discovery and the
 * offline probe both parse the same `adb devices -l` listing through the real
 * AdbClient, so the test drives the monitor exactly as adb's output would.
 */
function offlineMonitorHarness() {
  resetAdbClientCaches();
  const timer = new FakeTimer();
  let listing: string[] = [ROWS.device];
  const adb = new AdbClient(null, async (command: string): Promise<ExecResult> =>
    command.includes("adb devices")
      ? createExecResult(["List of devices attached", ...listing, ""].join("\n"), "")
      : createExecResult("", ""),
  );
  const emulator = new AndroidEmulatorClient(undefined, null, timer, new FakeAdbClientFactory(adb));
  let reconnects = 0;
  class ListingManager extends FakeDeviceManager {
    override async getBootedDevicesDetailed(
      platform: Parameters<FakeDeviceManager["getBootedDevicesDetailed"]>[0],
    ) {
      this.bootedDevices = (await adb.getDeviceStates())
        .filter((state) => state.state === "device")
        .map((state) => ({
          deviceId: state.deviceId,
          name: "Pixel",
          platform: "android" as const,
        }));
      return super.getBootedDevicesDetailed(platform);
    }
    async getAndroidOfflineDeviceIds(ids: Iterable<string>) {
      return emulator.getOfflineDeviceIdsAmong(ids);
    }
    async recoverAndroidOfflineDevices() {
      reconnects++;
    }
  }
  const device = { id: EMULATOR, platform: "android", incarnation: 1 };
  const cleanedUp: string[] = [];
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    timer,
    deviceDisconnectMonitor: null,
    deviceDisconnectMisses: new Map<string, number>(),
    deviceDisconnectMissIncarnations: new Map([[device.id, 1]]),
    confirmedDisconnectedDeviceIds: new Set(),
    forceDisconnectedDeviceIds: new Set(),
    offlineRecoveryAttemptedDeviceIds: new Set(),
    offlineRecoveryAttemptedIncarnations: new Map(),
    offlineEpisodes: new Map<string, OfflineEpisode>(),
    deferredSessionRecoverySweeps: new Set(),
    devicePool: {
      retryDueDeferredSessionRecoveries: async () => {},
      reconcileDiscoveryObservation: async () => {},
      mapAndroidDiscovery: (devices: BootedDevice[]) => devices,
      getAllDevices: () => [device],
      isDeviceLeasedForAndroidStartup: () => false,
      releaseAdbServerResetCohortReservations: async () => {},
    },
    sessionManager: {
      getAssignedDevices: () => [device.id],
      getAllSessions: () => [{ assignedDevice: device.id, platform: "android" }],
    },
    // The release path (session release, pool removal, in-flight cancel) starts here.
    cleanupDisconnectedDevice: async (deviceId: string) => {
      cleanedUp.push(deviceId);
    },
  });
  daemon.startDeviceDisconnectMonitor(new ListingManager(), async () => []);
  const monitor = daemon.deviceDisconnectMonitor as SingleFlightInterval;
  const sweepFor = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += POLL_MS) {
      await monitor.run();
      timer.advanceTime(POLL_MS);
    }
  };
  return {
    daemon,
    monitor,
    cleanedUp,
    sweepFor,
    reconnects: () => reconnects,
    list: (row: string) => {
      listing = [row];
    },
  };
}

describe("disconnect monitor offline budget (#11090)", () => {
  test("an emulator offline for 30 s then back to device keeps its session", async () => {
    const h = offlineMonitorHarness();
    try {
      await h.sweepFor(POLL_MS);
      h.list(ROWS.offline);
      await h.sweepFor(30_000);
      expect(h.cleanedUp).toEqual([]);
      expect(h.daemon.deviceDisconnectMisses.has(EMULATOR)).toBe(false);
      expect(h.reconnects()).toBe(1);

      h.list(ROWS.device);
      await h.sweepFor(POLL_MS);
      expect(h.cleanedUp).toEqual([]);
      expect(h.daemon.offlineEpisodes.size).toBe(0);
      expect(h.daemon.confirmedDisconnectedDeviceIds.size).toBe(0);
    } finally {
      await h.monitor.stop();
    }
  });

  test("an emulator offline beyond the budget is released as before", async () => {
    const h = offlineMonitorHarness();
    try {
      h.list(ROWS.offline);
      await h.sweepFor(OFFLINE_DEVICE_DISCONNECT_BUDGET_MS);
      expect(h.cleanedUp).toEqual([]);
      await h.monitor.run();
      expect(h.cleanedUp).toEqual([EMULATOR]);
    } finally {
      await h.monitor.stop();
    }
  });

  test("a serial absent from the listing keeps the three-miss rule", async () => {
    const h = offlineMonitorHarness();
    try {
      h.list("");
      await h.sweepFor(2 * POLL_MS);
      expect(h.cleanedUp).toEqual([]);
      await h.monitor.run();
      expect(h.cleanedUp).toEqual([EMULATOR]);
    } finally {
      await h.monitor.stop();
    }
  });
});

describe("evaluateDeviceDisconnects offline episodes", () => {
  const platforms = new Map<string, Platform>([[EMULATOR, "android"]]);
  const evaluate = (
    misses: Map<string, number>,
    episodes: Map<string, OfflineEpisode>,
    nowMs: number,
    offline: boolean,
  ) =>
    evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds: new Set(),
      candidateDeviceIds: new Set([EMULATOR]),
      succeededPlatforms: new Set(["android"]),
      candidatePlatforms: platforms,
      offlineDeviceIds: new Set(offline ? [EMULATOR] : []),
      offlineEpisodes: episodes,
      nowMs,
    });

  test("offline sweeps hold the absent miss streak instead of advancing or resetting it", () => {
    const misses = new Map([[EMULATOR, 2]]);
    const episodes = new Map<string, OfflineEpisode>();
    const result = evaluate(misses, episodes, 0, true);
    expect(result.disconnected).toEqual([]);
    expect(result.offline).toEqual([{ deviceId: EMULATOR, offlineForMs: 0 }]);
    expect(misses.get(EMULATOR)).toBe(2);
    expect(evaluate(misses, episodes, POLL_MS, false).disconnected).toEqual([EMULATOR]);
  });

  test("the episode survives interleaved absent sweeps so flapping stays bounded", () => {
    const misses = new Map<string, number>();
    const episodes = new Map<string, OfflineEpisode>();
    evaluate(misses, episodes, 0, true);
    evaluate(misses, episodes, 5_000, false);
    misses.clear();
    const result = evaluate(misses, episodes, OFFLINE_DEVICE_DISCONNECT_BUDGET_MS, true);
    expect(result.disconnected).toEqual([EMULATOR]);
  });
});
