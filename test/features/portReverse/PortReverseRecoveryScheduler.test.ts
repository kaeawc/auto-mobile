import { describe, expect, test } from "bun:test";
import {
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import {
  PORT_REVERSE_RECOVERY_SETTLE_MS,
  PortReverseRecoveryScheduler,
  type PortReverseRecoveryOutcome,
} from "../../../src/features/portReverse/PortReverseRecoveryScheduler";
import { subscribePortReverseTransportRecovery } from "../../../src/server/portReverseTools";
import { fixedBackoff } from "../../../src/utils/Backoff";
import { AdbTransportRecoveredSignal } from "../../../src/utils/android-cmdline-tools/adbTransportRecoveredSignal";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const DEVICE = "emulator-5554";
const RETRY_MS = 100;

const setup = (maxAttempts = 3) => {
  const adb = new FakeAdbReverseCommands();
  const timer = new FakeTimer();
  const manager = new PortReverseManager(() => undefined);
  const outcomes: PortReverseRecoveryOutcome[] = [];
  const scheduler = new PortReverseRecoveryScheduler({
    manager,
    timer,
    backoff: fixedBackoff(RETRY_MS),
    maxAttempts,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const target = (owner = "s1"): PortReverseTarget => ({ deviceId: DEVICE, owner, adb });
  /** Fires every timer due within `ms`, letting each reconcile it starts settle. */
  const advance = async (ms: number) => {
    timer.advanceTime(ms);
    await drainMicrotasks(20);
  };
  const adds = () => adb.calls.filter((call) => call.startsWith("add"));
  return { adb, timer, manager, scheduler, outcomes, target, advance, adds };
};

describe("PortReverseRecoveryScheduler", () => {
  test("a transport recovery restores a lost owned mapping without a portReverse call", async () => {
    const { adb, manager, scheduler, outcomes, target, advance } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();

    scheduler.deviceRecovered(DEVICE, "adb_reconnect");
    expect(adb.mappings.has(8080)).toBe(false);
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);

    expect(adb.mappings.get(8080)).toBe("tcp:8080");
    expect(outcomes).toEqual([
      { kind: "restored", deviceId: DEVICE, report: { restored: [8080], restoreFailures: [] } },
    ]);
    expect(scheduler.pendingDevices()).toEqual([]);
    // The owning session's next call reports the background restore once.
    const verified = await manager.verify(target());
    expect(verified.restored).toEqual([8080]);
    expect(verified.mappings[0]).toMatchObject({ devicePort: 8080, status: "restored" });
    expect((await manager.verify(target())).restored).toEqual([]);
  });

  test("foreign mappings are never touched, and a re-pointed owned port is left alone", async () => {
    const { adb, manager, scheduler, target, advance, adds } = setup();
    adb.mappings.set(3000, "tcp:3000");
    await manager.ensure(target(), [
      { devicePort: 8080, hostPort: 8080 },
      { devicePort: 9090, hostPort: 9090 },
    ]);
    adb.dropAll();
    adb.mappings.set(3000, "tcp:3000");
    adb.mappings.set(9090, "tcp:7777");

    scheduler.deviceRecovered(DEVICE, "ctrl_proxy_reconnect");
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);

    expect([...adb.mappings].sort()).toEqual([
      [3000, "tcp:3000"],
      [8080, "tcp:8080"],
      [9090, "tcp:7777"],
    ]);
    expect(adds().slice(2)).toEqual(["add 8080 8080 no-rebind"]);
    expect(adb.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(manager.ownedPorts(DEVICE)).toEqual([8080]);
  });

  test("a device still reconnecting is retried with backoff until the restore lands", async () => {
    const { adb, manager, scheduler, outcomes, target, advance } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    adb.failList = true;

    scheduler.deviceRecovered(DEVICE, "adb_reconnect");
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);
    expect(outcomes).toEqual([]);
    expect(scheduler.pendingDevices()).toEqual([DEVICE]);

    adb.failList = false;
    await advance(RETRY_MS);
    expect(adb.mappings.get(8080)).toBe("tcp:8080");
    expect(outcomes.map((o) => o.kind)).toEqual(["restored"]);
  });

  test("a restore failure is reported, kept owned, and surfaces in the next call", async () => {
    const { adb, manager, scheduler, outcomes, target, advance } = setup(2);
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    adb.failAdd.add(8080);

    scheduler.deviceRecovered(DEVICE, "transport_refusal");
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);
    await advance(RETRY_MS);

    expect(outcomes).toEqual([
      {
        kind: "failed",
        deviceId: DEVICE,
        attempts: 2,
        error: "tcp:8080: adb: error: cannot bind",
      },
    ]);
    expect(scheduler.pendingDevices()).toEqual([]);
    expect(manager.ownedPorts(DEVICE)).toEqual([8080]);
    const verified = await manager.verify(target());
    expect(verified.restoreFailures).toEqual([
      { devicePort: 8080, error: "adb: error: cannot bind" },
    ]);
    expect(verified.mappings[0]).toMatchObject({ owned: true, status: "missing" });
  });

  test("a device without owned mappings is never reconciled", async () => {
    const { adb, scheduler, timer } = setup();
    scheduler.deviceRecovered(DEVICE, "adb_reconnect");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(adb.calls).toEqual([]);
  });

  test("recovery events for one device coalesce into one reconcile", async () => {
    const { adb, manager, scheduler, outcomes, target, advance } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    const listsBefore = adb.calls.filter((call) => call === "list").length;

    scheduler.deviceRecovered(DEVICE, "transport_refusal");
    scheduler.deviceRecovered(DEVICE, "ctrl_proxy_reconnect");
    scheduler.deviceRecovered(DEVICE, "adb_reconnect");
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);

    expect(adb.calls.filter((call) => call === "list").length - listsBefore).toBe(1);
    expect(outcomes).toHaveLength(1);
  });

  test("the transport-recovered signal drives the scheduler until unsubscribed", async () => {
    const { adb, manager, scheduler, target, timer, advance } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    const signal = new AdbTransportRecoveredSignal();
    const stop = subscribePortReverseTransportRecovery(signal, scheduler);

    adb.dropAll();
    signal.notify(DEVICE, "ctrl_proxy_reconnect");
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);
    expect(adb.mappings.get(8080)).toBe("tcp:8080");

    stop();
    adb.dropAll();
    signal.notify(DEVICE, "ctrl_proxy_reconnect");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(adb.mappings.has(8080)).toBe(false);
  });
});
