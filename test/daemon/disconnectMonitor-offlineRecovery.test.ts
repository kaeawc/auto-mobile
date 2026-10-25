import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { AndroidTransportAliases } from "../../src/utils/androidSerial";
import { createExecResult } from "../../src/utils/execResult";
import type { BootedDevice } from "../../src/models";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createMonitorDaemon,
  heldAndroidDevice,
  heldSession,
} from "../helpers/disconnectMonitorDaemon";
import { describe, expect, spyOn, test } from "bun:test";
import {
  pruneStaleOfflineRecoveryAttempts,
  selectOfflineRecoveryCandidates,
} from "../../src/daemon/disconnectMonitor";

describe("selectOfflineRecoveryCandidates", () => {
  test("selects an offline candidate that has not yet had a recovery attempt", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });

  test("skips a candidate already attempted this episode", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
    );

    expect(targets).toEqual([]);
  });

  test("ignores an offline serial that is no longer a tracked candidate", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(),
      new Set(),
    );

    expect(targets).toEqual([]);
  });

  test("selects only the offline ones out of several candidates", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554", "emulator-5556"]),
      new Set(),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });

  test("excludes a serial with an in-flight provisionDevice/startDevice lease (#7536)", () => {
    // AndroidEmulatorClient's own fresh-provision readiness wait
    // (maybeRecoverFreshOffline) already owns bounded offline recovery for a
    // serial mid-startup, on its own 15s threshold. The monitor must not race
    // a second concurrent 'adb -s <serial> reconnect' against that dispatch.
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
      new Set(["emulator-5554"]),
    );

    expect(targets).toEqual([]);
  });

  test("still selects an offline candidate with no in-flight startup lease", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554", "emulator-5556"]),
      new Set(["emulator-5554", "emulator-5556"]),
      new Set(),
      new Set(["emulator-5556"]),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });

  test("defaults to no in-flight-startup exclusions when the parameter is omitted", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });
});

describe("pruneStaleOfflineRecoveryAttempts", () => {
  test("keeps an attempted entry while the serial is still a candidate and still offline", () => {
    const pruned = pruneStaleOfflineRecoveryAttempts(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
    );

    expect(pruned).toEqual(new Set(["emulator-5554"]));
  });

  test("drops an attempted entry once the serial recovers (leaves offline)", () => {
    const pruned = pruneStaleOfflineRecoveryAttempts(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
    );

    expect(pruned).toEqual(new Set());
  });

  test("drops an attempted entry once the serial leaves the candidate set", () => {
    const pruned = pruneStaleOfflineRecoveryAttempts(
      new Set(["emulator-5554"]),
      new Set(),
      new Set(["emulator-5554"]),
    );

    expect(pruned).toEqual(new Set());
  });

  test("a later offline episode gets a fresh recovery attempt after pruning", () => {
    let attempted = new Set(["emulator-5554"]);

    // Episode 1 ends: the serial came back online.
    attempted = pruneStaleOfflineRecoveryAttempts(attempted, new Set(["emulator-5554"]), new Set());
    expect(attempted.size).toBe(0);

    // Episode 2 begins: offline again, and it is a fresh recovery target.
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      attempted,
    );
    expect(targets).toEqual(["emulator-5554"]);
  });
});

test("a new incarnation at an offline serial receives its own reconnect attempt", () => {
  const ids = new Set(["emulator-5554"]);
  const pruned = pruneStaleOfflineRecoveryAttempts(
    ids,
    ids,
    ids,
    new Map([["emulator-5554", 1]]),
    new Map([["emulator-5554", 2]]),
  );
  expect(selectOfflineRecoveryCandidates(ids, ids, pruned)).toEqual(["emulator-5554"]);
});

test("failed offline probes preserve attempts for the same incarnation", () => {
  const ids = new Set(["emulator-5554"]);
  const incarnations = new Map([["emulator-5554", 1]]);
  const pruned = pruneStaleOfflineRecoveryAttempts(ids, ids, undefined, incarnations, incarnations);
  expect(selectOfflineRecoveryCandidates(ids, ids, pruned)).toEqual([]);
  expect(
    pruneStaleOfflineRecoveryAttempts(pruned, ids, new Set(), incarnations, incarnations).size,
  ).toBe(0);
});

function monitorHarness(
  manager: FakeDeviceManager & {
    getAndroidOfflineDeviceIds(ids: Iterable<string>): Promise<Set<string>>;
    recoverAndroidOfflineDevices(ids: Iterable<string>): Promise<void>;
  },
) {
  const timer = new FakeTimer();
  const device = heldAndroidDevice("emulator-5554");
  const { daemon, spies } = createMonitorDaemon({
    timer,
    device,
    missIncarnations: new Map([[device.id, 1]]),
  });
  daemon.testHooks.startDeviceDisconnectMonitor(manager, async () => []);
  return {
    daemon,
    device,
    timer,
    spies,
    monitor: daemon.testHooks.runtime.deviceDisconnectMonitor as SingleFlightInterval,
  };
}

test("monitor dispatches only in-session offline targets", async () => {
  const received: string[][] = [];
  class OfflineManager extends FakeDeviceManager {
    async getAndroidOfflineDeviceIds() {
      return new Set(["emulator-5554", "emulator-5556", "emulator-5558"]);
    }
    async recoverAndroidOfflineDevices(ids: Iterable<string>) {
      received.push([...ids]);
    }
  }
  const { device, monitor, spies } = monitorHarness(new OfflineManager());
  const second = { ...device, id: "emulator-5558" };
  spies.getAllDevices.mockImplementation(() => [device, second]);
  spies.getAssignedDevices.mockImplementation(() => new Set([device.id, second.id]));
  spies.getAllSessions.mockImplementation(() =>
    [device, second].map((target) => heldSession(target.id)),
  );
  await monitor.run();
  await monitor.stop();
  expect(received).toEqual([["emulator-5554", "emulator-5558"]]);
});

test("monitor reconnects an emulator's listed-offline serial and ignores foreign rows", async () => {
  const received: string[][] = [];
  const probes: string[][] = [];
  class ListedOfflineManager extends FakeDeviceManager {
    async getAndroidOfflineDeviceIds() {
      return new Set<string>();
    }
    async getAndroidListedDeviceStates(ids: Iterable<string>) {
      probes.push([...ids]);
      return new Map([
        ["emulator-5554", "offline"],
        ["emulator-5556", "offline"],
      ]);
    }
    async recoverAndroidOfflineDevices(ids: Iterable<string>) {
      received.push([...ids]);
    }
  }
  const { monitor } = monitorHarness(new ListedOfflineManager());
  try {
    await monitor.run();
    expect(probes).toEqual([["emulator-5554"]]);
    expect(received).toEqual([["emulator-5554"]]);
  } finally {
    await monitor.stop();
  }
});

test.each(["emulator-5554", "localhost:5555"])(
  "a reconnect to %s completing at two misses is rediscovered before disconnect evaluation",
  async (recoveredId) => {
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    class RecoveringManager extends FakeDeviceManager {
      async getAndroidOfflineDeviceIds() {
        return new Set(["emulator-5554"]);
      }
      async recoverAndroidOfflineDevices() {
        entered.resolve();
        await complete.promise;
        this.bootedDevices = [{ deviceId: recoveredId, platform: "android", name: "Pixel" }];
      }
    }
    const { daemon, monitor, spies } = monitorHarness(new RecoveringManager());
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult("EMULATOR-SERIAL", ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
    const initial: BootedDevice[] = [
      { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
      { deviceId: "localhost:5555", name: "Pixel", platform: "android" },
    ];
    aliases.fold(initial, await aliases.prepare(initial), new Set(["emulator-5554"]));
    spies.mapAndroidDiscovery.mockImplementation((rows: BootedDevice[]) =>
      aliases.mapDiscovery(rows),
    );
    daemon.testHooks.deviceLoss.misses.set("emulator-5554", 2);
    const sweep = monitor.run();
    await entered.promise;
    expect(daemon.testHooks.deviceLoss.misses.get("emulator-5554")).toBe(2);
    complete.resolve();
    await sweep;
    expect(daemon.testHooks.deviceLoss.misses.has("emulator-5554")).toBe(false);
    expect(daemon.testHooks.deviceLoss.confirmedDisconnectedIds.size).toBe(0);
    await monitor.stop();
  },
);

test("alternating successful and failed offline probes do not repeat global reconnect", async () => {
  const probeEntered = Promise.withResolvers<void>();
  const failProbe = Promise.withResolvers<void>();
  let fail = false;
  class ProbeExecutor extends FakeAdbExecutor {
    override async getDeviceStates() {
      if (fail) {
        probeEntered.resolve();
        await failProbe.promise;
        throw new Error("ADB probe unavailable");
      }
      return [{ deviceId: "emulator-5554", state: "offline" as const }];
    }
  }
  const client = new AndroidEmulatorClient({
    timer: new FakeTimer(),
    adbFactory: new FakeAdbClientFactory(new ProbeExecutor()),
  });
  let reconnects = 0;
  class OfflineManager extends FakeDeviceManager {
    async getAndroidOfflineDeviceIds(ids: Iterable<string>) {
      return client.getOfflineDeviceIdsAmong(ids);
    }
    async recoverAndroidOfflineDevices() {
      reconnects++;
    }
  }
  const { daemon, monitor, device } = monitorHarness(new OfflineManager());
  await monitor.run();
  expect(reconnects).toBe(1);
  fail = true;
  const failedSweep = monitor.run();
  await probeEntered.promise;
  expect(daemon.testHooks.deviceLoss.offlineRecoveryAttemptedIds.has(device.id)).toBe(true);
  failProbe.resolve();
  await failedSweep;
  expect(daemon.testHooks.deviceLoss.offlineRecoveryAttemptedIds.has(device.id)).toBe(true);
  fail = false;
  daemon.testHooks.deviceLoss.misses.clear();
  await monitor.run();
  expect(reconnects).toBe(1);
  device.incarnation++;
  await monitor.run();
  expect(reconnects).toBe(2);
  await monitor.stop();
});

test("B1 defers the global reconnect when another offline candidate owns startup recovery", async () => {
  let reconnects = 0;
  class OfflineManager extends FakeDeviceManager {
    async getAndroidOfflineDeviceIds() {
      return new Set(["emulator-5554", "emulator-5556"]);
    }
    async recoverAndroidOfflineDevices() {
      reconnects++;
    }
  }
  const { daemon, device, monitor, spies } = monitorHarness(new OfflineManager());
  const protectedDevice = { ...device, id: "emulator-5556" };
  spies.getAllDevices.mockImplementation(() => [device, protectedDevice]);
  spies.isDeviceLeasedForAndroidStartup.mockImplementation(
    (id: string) => id === protectedDevice.id,
  );
  await monitor.run();
  const attempts = daemon.testHooks.deviceLoss.offlineRecoveryAttemptedIds.size;
  const protectedReconnects = reconnects;
  spies.isDeviceLeasedForAndroidStartup.mockImplementation(() => false);
  await monitor.run();
  await monitor.stop();
  expect(protectedReconnects).toBe(0);
  expect(attempts).toBe(0);
  expect(reconnects).toBe(1);
});

test.each([
  ["emulator-5554", "localhost:5555", "Pixel"],
  ["PHONE-USB", "host-a:5555", undefined],
])(
  "held %s remains present in the disconnect monitor when only %s survives",
  async (canonical, alias, avd) => {
    let offlineProbes = 0;
    let recoveries = 0;
    class AliasManager extends FakeDeviceManager {
      async getAndroidOfflineDeviceIds() {
        offlineProbes++;
        return new Set<string>();
      }
      async recoverAndroidOfflineDevices() {
        recoveries++;
      }
    }
    const manager = new AliasManager();
    const { daemon, monitor, device, spies, timer } = monitorHarness(manager);
    device.id = canonical;
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult(canonical, ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult(avd ? "1" : "0", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult(avd ?? "", ""));
    adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
    const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
    const normalize = async (rows: BootedDevice[]) =>
      aliases.fold(rows, await aliases.prepare(rows), new Set([device.id]));
    await normalize([
      { deviceId: device.id, name: "Pixel", platform: "android" },
      { deviceId: alias, name: "Pixel", platform: "android" },
    ]);
    spies.mapAndroidDiscovery.mockImplementation((rows: BootedDevice[]) =>
      aliases.mapDiscovery(rows),
    );
    const identityCalls = adb.getExecutedCommands().length;
    adb.setCommandError("boot_id", new Error("timeout"));
    manager.bootedDevices = [{ deviceId: alias, name: "Pixel", platform: "android" }];
    let cleanups = 0;
    daemon.testHooks.overrideCleanupDisconnectedDevice(async () => {
      cleanups++;
    });
    try {
      for (let tick = 0; tick < 4; tick++) {
        await monitor.run();
      }
      expect(daemon.testHooks.deviceLoss.misses.size).toBe(0);
      expect(daemon.testHooks.deviceLoss.confirmedDisconnectedIds.size).toBe(0);
      expect(offlineProbes).toBe(0);
      expect(recoveries).toBe(0);
      expect(cleanups).toBe(0);
      expect(aliases.resolveTransport(device.id)).toBe(device.id);
      expect(adb.getExecutedCommands()).toHaveLength(identityCalls);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      await monitor.stop();
    }
  },
);

test("concurrent refresh and disconnect monitor do not probe twice or fail discovery", async () => {
  class AliasManager extends FakeDeviceManager {
    async getAndroidOfflineDeviceIds() {
      return new Set<string>();
    }
    async recoverAndroidOfflineDevices() {}
  }
  const manager = new AliasManager();
  const { daemon, monitor, device, timer } = monitorHarness(manager);
  const row = (deviceId: string): BootedDevice => ({
    deviceId,
    name: deviceId,
    platform: "android",
  });
  const usb = "PHONE-USB";
  const wifi = "host-a:5555";
  manager.bootedDevices = [row(usb), row(wifi)];
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("ro.serialno", createExecResult(usb, ""));
  adb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
  adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
  const pool = new DevicePool(
    createDevicePoolDependencies(
      new SessionManager(timer, new FakeDeviceSessionPersistence()),
      "monitor-alias",
      {
        timer,
        deviceManager: manager,
        androidAdbFactory: new FakeAdbClientFactory(adb),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      },
    ),
  );
  daemon.testHooks.replaceDevicePool(pool);
  device.id = usb;
  await pool.refreshDevices();
  await pool.assignDeviceToSession("owner-a", "android");
  manager.bootedDevices = [row(wifi), row("host-new:5555")];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ReturnType<typeof createExecResult>>();
  const execute = adb.execute.bind(adb);
  const probe = spyOn(adb, "execute").mockImplementationOnce(async () => {
    entered.resolve();
    return release.promise;
  });
  const normalization = spyOn(pool, "normalizeAndroidDiscovery");
  const refresh = pool.refreshDevicesWithOutcome();
  let sweep: Promise<void> | undefined;
  try {
    await entered.promise;
    probe.mockImplementation(execute);
    const calls = adb.getExecutedCommands().length;
    sweep = monitor.run();
    await drainMicrotasks(100);
    expect(normalization).toHaveBeenCalledTimes(1);
    expect(adb.getExecutedCommands()).toHaveLength(calls);
    expect(daemon.testHooks.deviceLoss.misses.size).toBe(0);
    release.resolve(createExecResult(usb, ""));
    await expect(sweep).resolves.toBeUndefined();
    expect((await refresh).failure).toBeUndefined();
    expect(pool.getDevice(usb)?.sessionId).toBe("owner-a");
    expect(pool.getAndroidTransportRouting().resolveTransport(usb)).toBe(wifi);
    expect(timer.getSleepHistory()).toEqual([]);
  } finally {
    release.resolve(createExecResult(usb, ""));
    await refresh;
    await sweep;
    normalization.mockRestore();
    probe.mockRestore();
    await monitor.stop();
    timer.reset();
  }
});
