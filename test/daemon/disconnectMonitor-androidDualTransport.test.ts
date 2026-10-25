import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import type { BootedDevice } from "../../src/models";
import {
  AdbClient,
  resetAdbDeviceListCache,
} from "../../src/utils/android-cmdline-tools/AdbClient";
import { createExecResult } from "../../src/utils/execResult";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { heldSession } from "../helpers/disconnectMonitorDaemon";

// A phone reachable over USB and/or wireless adb (#11133).
const USB = "R58N12ABCDE";
const WIFI = "192.168.1.42:41234";
const WIFI_NEW_PORT = "192.168.1.42:39871";
const ROWS: Record<string, string> = {
  [USB]: `${USB}            device usb:1-1 product:a54xeea model:SM_A546B device:a54x transport_id:3`,
  [WIFI]: `${WIFI}     device product:a54xeea model:SM_A546B device:a54x transport_id:4`,
  [WIFI_NEW_PORT]: `${WIFI_NEW_PORT}     device product:a54xeea model:SM_A546B device:a54x transport_id:7`,
};

const timers: FakeTimer[] = [];
afterEach(() => {
  timers.splice(0).forEach((timer) => timer.reset());
  resetAdbDeviceListCache();
});

/** Parse a realistic `adb devices -l` listing through the production parser. */
async function adbDevices(timer: FakeTimer, ...serials: string[]): Promise<BootedDevice[]> {
  const stdout = ["List of devices attached", ...serials.map((serial) => ROWS[serial]), ""].join(
    "\n",
  );
  const client = new AdbClient(
    null,
    async (_file: string, _args: string[], _maxBuffer?: number) => createExecResult(stdout, ""),
    { retryExecutor: new DefaultRetryExecutor(timer), timer },
  );
  return await client.getBootedAndroidDevices({ bypassCache: true });
}

class PhoneManager extends FakeDeviceManager {
  async getAndroidOfflineDeviceIds(): Promise<Set<string>> {
    return new Set();
  }
  async recoverAndroidOfflineDevices(_ids: Iterable<string>): Promise<void> {}
}

async function harness(initial: string[], manager = new PhoneManager()) {
  const timer = new FakeTimer();
  timers.push(timer);
  manager.bootedDevices = await adbDevices(timer, ...initial);
  const probe = new FakeAdbExecutor();
  probe.setCommandResponse("getprop ro.serialno", createExecResult(USB, ""));
  probe.setCommandResponse("getprop ro.kernel.qemu", createExecResult("0", ""));
  probe.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "dual-transport-monitor", {
      timer,
      deviceManager: manager,
      androidAdbFactory: new FakeAdbClientFactory(probe),
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  await pool.refreshDevices();
  const canonical = await pool.assignDeviceToSession("owner", "android");
  const cleanups: string[] = [];
  const daemon = new Daemon({}, { timer });
  daemon.testHooks.replaceDevicePool(pool);
  spyOn(daemon.testHooks.sessionManager, "getAssignedDevices").mockImplementation(
    () => new Set([canonical]),
  );
  spyOn(daemon.testHooks.sessionManager, "getAllSessions").mockImplementation(() => [
    heldSession(canonical),
  ]);
  daemon.testHooks.overrideCleanupDisconnectedDevice(async (deviceId) => {
    cleanups.push(deviceId);
  });
  daemon.testHooks.startDeviceDisconnectMonitor(manager, async () => []);
  return {
    timer,
    manager,
    pool,
    probe,
    canonical,
    cleanups,
    daemon,
    monitor: daemon.testHooks.runtime.deviceDisconnectMonitor as SingleFlightInterval,
  };
}

describe("disconnect monitor folds a re-ported wireless transport (#11133)", () => {
  test.each([
    ["Wi-Fi only", [WIFI], WIFI],
    ["USB + Wi-Fi after USB unplug", [USB, WIFI], USB],
  ])("%s: a wireless port change keeps the held session", async (_label, initial, expected) => {
    const h = await harness(initial);
    expect(h.canonical).toBe(expected);
    h.manager.bootedDevices = await adbDevices(h.timer, WIFI_NEW_PORT);
    try {
      for (let tick = 0; tick < 4; tick++) {
        await h.monitor.run();
      }
      expect(h.daemon.testHooks.deviceLoss.misses.size).toBe(0);
      expect(h.daemon.testHooks.deviceLoss.confirmedDisconnectedIds.size).toBe(0);
      expect(h.cleanups).toEqual([]);
      expect(h.pool.getDevice(expected)?.sessionId).toBe("owner");
      expect(h.pool.getAndroidTransportRouting().resolveTransport(expected)).toBe(WIFI_NEW_PORT);
      expect(h.timer.getSleepHistory()).toEqual([]);
    } finally {
      await h.monitor.stop();
    }
  });

  test("an unrelated pooled loss with no unmapped transport row never probes identity", async () => {
    const h = await harness([USB, WIFI]);
    const probes = h.probe.getExecutedCommands().length;
    h.manager.bootedDevices = [];
    try {
      await h.monitor.run();
      expect(h.probe.getExecutedCommands()).toHaveLength(probes);
      expect(h.daemon.testHooks.deviceLoss.misses.has(USB)).toBe(true);
    } finally {
      await h.monitor.stop();
    }
  });
});

describe("listed-state probe follows a held phone's alias serials (#11133)", () => {
  test.each([
    ["alias only", [WIFI]],
    ["canonical only", [USB]],
    ["both transports", [USB, WIFI]],
  ] as const)(
    "reconnects listed-offline %s once per canonical episode",
    async (_label, offline) => {
      const received: string[][] = [];
      const probes: string[][] = [];
      class RecordingManager extends PhoneManager {
        async getAndroidListedDeviceStates(ids: Iterable<string>): Promise<Map<string, string>> {
          probes.push([...ids]);
          // Return the full listing to exercise rejection of unrelated offline rows.
          return new Map(this.androidListedDeviceStates);
        }
        async recoverAndroidOfflineDevices(ids: Iterable<string>): Promise<void> {
          received.push([...ids]);
        }
      }
      const h = await harness([USB, WIFI], new RecordingManager());
      expect(h.canonical).toBe(USB);
      h.manager.bootedDevices = [];
      h.manager.androidListedDeviceStates = new Map([
        [USB, "unauthorized"],
        [WIFI, "authorizing"],
        ...offline.map((id): [string, string] => [id, "offline"]),
        ["192.168.1.99:40000", "offline"],
      ]);
      try {
        await h.monitor.run();
        expect(probes).toEqual([[USB, WIFI]]);
        expect(received).toEqual([[...offline]]);
        expect(h.daemon.testHooks.deviceLoss.offlineRecoveryAttemptedIds).toEqual(new Set([USB]));
        expect([
          ...h.daemon.testHooks.deviceLoss.offlineRecoveryAttemptedIncarnations.keys(),
        ]).toEqual([USB]);
        expect([...h.daemon.testHooks.deviceLoss.offlineEpisodes.keys()]).toEqual([USB]);
        expect(h.daemon.testHooks.deviceLoss.misses.size).toBe(0);
        await h.monitor.run();
        expect(received).toEqual([[...offline]]);
        expect(h.cleanups).toEqual([]);
        expect(h.pool.getDevice(USB)?.sessionId).toBe("owner");
        expect(h.timer.getSleepHistory()).toEqual([]);
      } finally {
        await h.monitor.stop();
      }
    },
  );

  test.each(["offline", "authorizing"])(
    "USB unplugged while the Wi-Fi alias is %s keeps the session on the first sweep",
    async (state) => {
      const h = await harness([USB, WIFI]);
      expect(h.canonical).toBe(USB);
      h.manager.bootedDevices = [];
      h.manager.androidListedDeviceStates = new Map([[WIFI, state]]);
      try {
        await h.monitor.run();
        expect(h.cleanups).toEqual([]);
        expect(h.daemon.testHooks.deviceLoss.confirmedDisconnectedIds.size).toBe(0);
        expect(h.pool.getDevice(USB)?.sessionId).toBe("owner");
        // `offline` is held by the offline budget; other states keep the debounce.
        expect(h.daemon.testHooks.deviceLoss.misses.get(USB)).toBe(
          state === "offline" ? undefined : 1,
        );
      } finally {
        await h.monitor.stop();
      }
    },
  );
});
