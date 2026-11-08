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
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
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
    const stop = subscribePortReverseTransportRecovery(signal, scheduler, manager, () => () => {});

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

  test("a reconcile triggered inside a cancelled tool request does not inherit its abort", async () => {
    const { adb, manager, scheduler, outcomes, target, advance } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    const ambient: (boolean | undefined)[] = [];
    const list = adb.list.bind(adb);
    adb.list = async () => {
      ambient.push(getAbortSignal()?.aborted);
      return list();
    };
    const cancelled = new AbortController();
    cancelled.abort();

    await runWithAbortSignal(cancelled.signal, async () => {
      scheduler.deviceRecovered(DEVICE, "transport_refusal");
      await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);
    });

    expect(ambient).toEqual([undefined]);
    expect(adb.mappings.get(8080)).toBe("tcp:8080");
    expect(outcomes.map((o) => o.kind)).toEqual(["restored"]);
  });

  test("an event during a failed final attempt still gets its own reconcile", async () => {
    const { adb, manager, scheduler, outcomes, target, advance } = setup(1);
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    adb.failList = true;
    const list = adb.list;
    adb.list = new Proxy(adb.list, {
      apply: (fn, self, args) => {
        // The device answers again while the failing attempt runs, and says so.
        adb.failList = false;
        scheduler.deviceRecovered(DEVICE, "ctrl_proxy_reconnect");
        adb.failList = true;
        return Reflect.apply(fn, self, args);
      },
    });
    scheduler.deviceRecovered(DEVICE, "adb_reconnect");
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);
    expect(outcomes).toEqual([]);
    expect(scheduler.pendingDevices()).toEqual([DEVICE]);

    // The device is back for good: the deferred reconcile restores the mapping.
    adb.list = list;
    adb.failList = false;
    await advance(0);
    expect(adb.mappings.get(8080)).toBe("tcp:8080");
    expect(outcomes.map((o) => o.kind)).toEqual(["restored"]);
  });

  test("identity replacement cancels the episode and forgets the old device's mappings", async () => {
    const { adb, manager, scheduler, target, timer, advance, adds } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    let identity: { onDeviceIdentityReplaced?(deviceId: string): void } | undefined;
    const stop = subscribePortReverseTransportRecovery(
      new AdbTransportRecoveredSignal(),
      scheduler,
      manager,
      (listener) => {
        identity = listener;
        return () => {};
      },
    );
    adb.dropAll();
    scheduler.deviceRecovered(DEVICE, "ctrl_proxy_reconnect");
    identity?.onDeviceIdentityReplaced?.(DEVICE);

    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(manager.ownedPorts(DEVICE)).toEqual([]);
    await manager.reconcile(DEVICE);
    await advance(PORT_REVERSE_RECOVERY_SETTLE_MS);
    expect(adds()).toEqual(["add 8080 8080 no-rebind"]);
    expect(adb.mappings.has(8080)).toBe(false);
    stop();
  });

  test("forgetting the device mid-reconcile stops further adds and undoes the in-flight one", async () => {
    const { adb, manager, adds } = setup();
    await manager.ensure({ deviceId: DEVICE, owner: "s1", adb }, [
      { devicePort: 8080, hostPort: 8080 },
      { devicePort: 9090, hostPort: 9090 },
    ]);
    adb.dropAll();
    const gate = Promise.withResolvers<void>();
    adb.addGate = gate.promise;

    const reconciling = manager.reconcile(DEVICE);
    await drainMicrotasks(20);
    expect(adds().slice(2)).toEqual(["add 8080 8080 no-rebind"]);
    manager.forgetDevice(DEVICE);
    gate.resolve();
    const report = await reconciling;

    expect(adds().slice(2)).toEqual(["add 8080 8080 no-rebind"]);
    expect(adb.calls).toContain("remove 8080");
    expect([...adb.mappings]).toEqual([]);
    expect(report.restored).toEqual([]);
  });

  test("an in-flight restore is not undone when the port now maps somewhere else", async () => {
    const { adb, manager } = setup();
    await manager.ensure({ deviceId: DEVICE, owner: "s1", adb }, [
      { devicePort: 8080, hostPort: 8080 },
    ]);
    adb.dropAll();
    const gate = Promise.withResolvers<void>();
    adb.addGate = gate.promise;
    const reconciling = manager.reconcile(DEVICE);
    await drainMicrotasks(20);
    manager.forgetDevice(DEVICE);
    gate.resolve();
    // The replacement device's own mapping takes the port before the undo reads --list.
    const list = adb.list.bind(adb);
    adb.list = async () => {
      adb.mappings.set(8080, "tcp:7777");
      return list();
    };
    await reconciling;
    expect(adb.calls).not.toContain("remove 8080");
    expect(adb.mappings.get(8080)).toBe("tcp:7777");
  });

  test("an undo that fails stays pending for the device's next call", async () => {
    const { adb, manager } = setup();
    await manager.ensure({ deviceId: DEVICE, owner: "s1", adb }, [
      { devicePort: 8080, hostPort: 8080 },
    ]);
    adb.dropAll();
    const gate = Promise.withResolvers<void>();
    adb.addGate = gate.promise;
    adb.failRemove.add(8080);
    const reconciling = manager.reconcile(DEVICE);
    await drainMicrotasks(20);
    manager.forgetDevice(DEVICE);
    gate.resolve();
    await reconciling;
    expect(manager.pendingRemovals(DEVICE)).toEqual([8080]);

    adb.failRemove.clear();
    await manager.list({ deviceId: DEVICE, owner: "s2", adb });
    expect(adb.mappings.has(8080)).toBe(false);
    expect(manager.pendingRemovals(DEVICE)).toEqual([]);
  });
});
