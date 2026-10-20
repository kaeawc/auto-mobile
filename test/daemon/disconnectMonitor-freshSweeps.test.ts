import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { makePool } from "../helpers/makePool";
import { describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import type { OfflineEpisode } from "../../src/daemon/disconnectMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import type { BootedDeviceDiscoveryOptions } from "../../src/devices/deviceUtils";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * The monitor's miss threshold counts "consecutive successful discovery sweeps". The device
 * listings are TTL-cached (5 s, stamped when the command completes) so the next 5 s tick lands
 * just inside the TTL and re-reads the previous snapshot: unless the monitor bypasses the cache, one
 * real absence is counted twice and a device is declared lost after two independent observations
 * (#13551).
 */

const POLL_MS = 5_000;
// The command's own duration pushes the cache stamp past the tick, so the next tick is a hit.
const CACHE_TTL_MS = 6_000;
const SESSION = "holder-session";
const REQUIRED_MISSES = 3;

interface MonitorSurface {
  deviceDisconnectMonitor: SingleFlightInterval;
  deviceDisconnectMisses: Map<string, number>;
  startDeviceDisconnectMonitor(
    manager: CachingListingManager,
    listRecordings: () => Promise<[]>,
  ): void;
}

/** A device manager whose adb and simctl listings are cached separately, like the real ones. */
class CachingListingManager extends FakeDeviceManager {
  /** Fresh listings per platform that found `watched` absent: independent absence observations. */
  freshAbsent = { android: 0, ios: 0 };
  /** How many sweeps asked a platform's listing to bypass its cache. */
  bypassRequests = { android: 0, ios: 0 };
  /** The platform's real state, which a fresh listing reads. */
  listed: BootedDevice[] = [];
  watched: BootedDevice | undefined;
  private readonly snapshots: Record<"android" | "ios", BootedDevice[] | undefined> = {
    android: undefined,
    ios: undefined,
  };
  private readonly stamps = { android: 0, ios: 0 };

  constructor(private readonly timer: FakeTimer) {
    super();
  }

  override async getBootedDevicesDetailed(
    platform: Parameters<FakeDeviceManager["getBootedDevicesDetailed"]>[0],
    options: BootedDeviceDiscoveryOptions = {},
  ) {
    const bypass = {
      android: options.bypassAndroidDeviceListCache === true,
      ios: options.bypassIosDeviceListCache === true,
    };
    for (const listing of ["android", "ios"] as const) {
      this.bypassRequests[listing] += bypass[listing] ? 1 : 0;
      const snapshot = this.snapshots[listing];
      const cached =
        !bypass[listing] &&
        snapshot !== undefined &&
        this.timer.now() - this.stamps[listing] < CACHE_TTL_MS;
      if (!cached) {
        this.snapshots[listing] = this.listed.filter((device) => device.platform === listing);
        this.stamps[listing] = this.timer.now();
        if (
          this.watched?.platform === listing &&
          !this.snapshots[listing]?.includes(this.watched)
        ) {
          this.freshAbsent[listing] += 1;
        }
      }
    }
    this.bootedDevices = [...(this.snapshots.android ?? []), ...(this.snapshots.ios ?? [])];
    return super.getBootedDevicesDetailed(platform);
  }

  async recoverAndroidOfflineDevices() {}
}

async function monitorFor(device: BootedDevice) {
  const timer = new FakeTimer();
  const ids = new FakeIdGenerator();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new CachingListingManager(timer);
  const pool = makePool(sessions, "daemon", {
    timer,
    idGenerator: ids,
    deviceManager: manager,
    emulatorLossIncidentStore: new InMemoryEmulatorLossIncidentStore(timer, ids),
    recoveryPolicy: { onLoss: false, maxAttempts: 0 },
    deviceSessionContinuityEnabled: false,
  });
  const image: DeviceInfo = {
    name: device.name,
    platform: device.platform,
    source: "local",
    isRunning: true,
  };
  manager.listed = [device];
  manager.watched = device;
  await pool.addDevice(device, image);
  await pool.bindOrReuseDeviceSession({
    sessionId: SESSION,
    deviceId: device.deviceId,
    platform: device.platform,
    sourceImage: image,
    expectedIdentity: device,
  });
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    timer,
    devicePool: pool,
    sessionManager: sessions,
    deviceDisconnectMonitor: null,
    deviceDisconnectMisses: new Map<string, number>(),
    deviceDisconnectMissIncarnations: new Map(),
    confirmedDisconnectedDeviceIds: new Set<string>(),
    forceDisconnectedDeviceIds: new Set(),
    forceDisconnectedDeviceGenerations: new Map(),
    offlineRecoveryAttemptedDeviceIds: new Set(),
    offlineRecoveryAttemptedIncarnations: new Map(),
    offlineEpisodes: new Map<string, OfflineEpisode>(),
    deferredSessionRecoverySweeps: new Set(),
  }) as MonitorSurface;
  daemon.startDeviceDisconnectMonitor(manager, async () => []);

  /** One 5 s tick with the holder heartbeating: only device loss can end the session. */
  const tick = async () => {
    if (sessions.getSession(SESSION)) {
      await deliverDaemonHeartbeat(sessions, SESSION);
    }
    timer.advanceTime(POLL_MS);
    await daemon.deviceDisconnectMonitor.run();
  };
  return {
    manager,
    sessions,
    tick,
    held: () => sessions.getSession(SESSION) !== null,
    stop: () => daemon.deviceDisconnectMonitor.stop(),
  };
}

describe.each([
  ["android", { deviceId: "emulator-5554", name: "Pixel", platform: "android" } as const],
  ["ios", { deviceId: "sim-held", name: "iPhone 16", platform: "ios" } as const],
])(
  "disconnect monitor counts only fresh listings toward the miss threshold (%s, #13551)",
  (_n, device) => {
    test("loss is confirmed on the third independent absent listing, never from a cached one", async () => {
      const h = await monitorFor(device);
      try {
        await h.tick();
        h.manager.listed = [];
        for (let i = 0; i < 8 && h.held(); i++) {
          await h.tick();
        }
        expect(h.held()).toBe(false);
        // The listing that confirmed the loss was the third fresh one to see the device absent,
        // not a re-read of the second.
        expect(h.manager.freshAbsent[device.platform]).toBe(REQUIRED_MISSES);
        // Only the watched platform's listing is forced fresh while confirming an absence.
        const other = device.platform === "android" ? "ios" : "android";
        expect(h.manager.bypassRequests[other]).toBe(0);
        expect(h.manager.bypassRequests[device.platform]).toBeGreaterThan(0);
      } finally {
        await h.stop();
      }
    });
  },
);
