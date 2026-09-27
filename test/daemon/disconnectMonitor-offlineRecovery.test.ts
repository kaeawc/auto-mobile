import { Daemon } from "../../src/daemon/daemon";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { describe, expect, test } from "bun:test";
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
    // a second concurrent 'adb reconnect offline' against that dispatch.
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
    recoverAndroidOfflineDevices(): Promise<void>;
  },
) {
  const timer = new FakeTimer();
  const device = { id: "emulator-5554", platform: "android", incarnation: 1 };
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    timer,
    deviceDisconnectMonitor: null,
    deviceDisconnectMisses: new Map<string, number>(),
    deviceDisconnectMissIncarnations: new Map([[device.id, 1]]),
    confirmedDisconnectedDeviceIds: new Set(),
    forceDisconnectedDeviceIds: new Set(),
    offlineRecoveryAttemptedDeviceIds: new Set(),
    offlineRecoveryAttemptedIncarnations: new Map(),
    deferredSessionRecoverySweeps: new Set(),
    devicePool: {
      retryDueDeferredSessionRecoveries: async () => {},
      reconcileDiscoveryObservation: async () => {},
      getAllDevices: () => [device],
      isDeviceLeasedForAndroidStartup: () => false,
      releaseAdbServerResetCohortReservations: async () => {},
    },
    sessionManager: {
      getAssignedDevices: () => [device.id],
      getAllSessions: () => [{ assignedDevice: device.id, platform: "android" }],
    },
  });
  daemon.startDeviceDisconnectMonitor(manager, async () => []);
  return { daemon, device, monitor: daemon.deviceDisconnectMonitor as SingleFlightInterval };
}

test("a reconnect completing at two misses is rediscovered before disconnect evaluation", async () => {
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  class RecoveringManager extends FakeDeviceManager {
    async getAndroidOfflineDeviceIds() {
      return new Set(["emulator-5554"]);
    }
    async recoverAndroidOfflineDevices() {
      entered.resolve();
      await complete.promise;
      this.bootedDevices = [{ deviceId: "emulator-5554", platform: "android", name: "Pixel" }];
    }
  }
  const { daemon, monitor } = monitorHarness(new RecoveringManager());
  daemon.deviceDisconnectMisses.set("emulator-5554", 2);
  const sweep = monitor.run();
  await entered.promise;
  expect(daemon.deviceDisconnectMisses.get("emulator-5554")).toBe(2);
  complete.resolve();
  await sweep;
  expect(daemon.deviceDisconnectMisses.has("emulator-5554")).toBe(false);
  expect(daemon.confirmedDisconnectedDeviceIds.size).toBe(0);
  await monitor.stop();
});

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
  const client = new AndroidEmulatorClient(
    undefined,
    null,
    new FakeTimer(),
    new FakeAdbClientFactory(new ProbeExecutor()),
  );
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
  expect(daemon.offlineRecoveryAttemptedDeviceIds.has(device.id)).toBe(true);
  failProbe.resolve();
  await failedSweep;
  expect(daemon.offlineRecoveryAttemptedDeviceIds.has(device.id)).toBe(true);
  fail = false;
  daemon.deviceDisconnectMisses.clear();
  await monitor.run();
  expect(reconnects).toBe(1);
  device.incarnation++;
  await monitor.run();
  expect(reconnects).toBe(2);
  await monitor.stop();
});
