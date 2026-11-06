import { describe, expect, test } from "bun:test";
import {
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import {
  PortReversePeriodicReconciler,
  type PortReverseReconcilePass,
} from "../../../src/features/portReverse/PortReversePeriodicReconciler";
import { subscribePortReversePeriodicReconcile } from "../../../src/server/portReverseTools";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const INTERVAL_MS = 1000;

const setup = (maxDevicesPerPass = 4) => {
  const timer = new FakeTimer();
  const audits: string[] = [];
  const manager = new PortReverseManager((event) => audits.push(event));
  const passes: PortReverseReconcilePass[] = [];
  const reconciler = new PortReversePeriodicReconciler({
    manager,
    timer,
    intervalMs: INTERVAL_MS,
    maxDevicesPerPass,
    onPass: (pass) => passes.push(pass),
  });
  const unsubscribe = subscribePortReversePeriodicReconcile(manager, reconciler);
  const devices = new Map<string, FakeAdbReverseCommands>();
  const target = (deviceId = "emulator-5554", owner = "s1"): PortReverseTarget => {
    const adb = devices.get(deviceId) ?? new FakeAdbReverseCommands();
    devices.set(deviceId, adb);
    return { deviceId, owner, adb };
  };
  const adbFor = (deviceId = "emulator-5554") => devices.get(deviceId)!;
  /** Fires the timers due within `ms`, letting the pass each one starts settle. */
  const advance = async (ms: number) => {
    timer.advanceTime(ms);
    await drainMicrotasks(50);
  };
  return { timer, audits, manager, reconciler, passes, target, adbFor, advance, unsubscribe };
};

describe("PortReversePeriodicReconciler", () => {
  test("re-adds an owned mapping removed by adb reverse --remove outside AutoMobile", async () => {
    const { manager, target, adbFor, advance, audits, passes } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8081 }]);
    const adb = adbFor();
    // Raw `adb reverse --remove tcp:8080` from another tool: no AutoMobile call follows.
    adb.mappings.delete(8080);

    await advance(INTERVAL_MS);

    expect(adb.mappings.get(8080)).toBe("tcp:8081");
    expect(passes).toEqual([
      { devices: [{ deviceId: "emulator-5554", restored: [8080], restoreFailures: [] }] },
    ]);
    expect(audits).toContain("restore tcp:8080 -> tcp:8081 device=emulator-5554 session=s1");
    // The owning session's next call reports the background restore once.
    expect((await manager.verify(target())).restored).toEqual([8080]);
  });

  test("is off while no session owns a mapping, and stops once the last one is released", async () => {
    const { timer, manager, target, adbFor, advance, passes } = setup();
    expect(timer.getPendingTimeoutCount()).toBe(0);

    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    // A second ensure does not stack another timer.
    await manager.ensure(target(), [{ devicePort: 9090, hostPort: 9090 }]);
    expect(timer.getPendingTimeoutCount()).toBe(1);

    await manager.releaseOwner("s1");
    const callsBefore = adbFor().calls.length;
    await advance(INTERVAL_MS);

    expect(passes).toEqual([]);
    expect(adbFor().calls.length).toBe(callsBefore);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("never touches a foreign mapping and keeps running while mappings stay owned", async () => {
    const { manager, target, adbFor, advance, passes } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    const adb = adbFor();
    adb.mappings.set(3000, "tcp:3000");

    await advance(INTERVAL_MS);
    await advance(INTERVAL_MS);

    expect([...adb.mappings].sort()).toEqual([
      [3000, "tcp:3000"],
      [8080, "tcp:8080"],
    ]);
    expect(adb.calls.filter((call) => call.startsWith("add") || call.startsWith("remove"))).toEqual(
      ["add 8080 8080 no-rebind"],
    );
    expect(passes).toHaveLength(2);
  });

  test("bounds each pass to maxDevicesPerPass and rotates through the rest", async () => {
    const { manager, target, adbFor, advance, passes } = setup(2);
    const ids = ["d1", "d2", "d3"];
    for (const id of ids) {
      await manager.ensure(target(id), [{ devicePort: 8080, hostPort: 8080 }]);
      adbFor(id).mappings.clear();
    }

    await advance(INTERVAL_MS);
    await advance(INTERVAL_MS);

    expect(passes.map((pass) => pass.devices.map((d) => d.deviceId))).toEqual([
      ["d1", "d2"],
      ["d3", "d1"],
    ]);
    expect(ids.map((id) => adbFor(id).mappings.get(8080))).toEqual([
      "tcp:8080",
      "tcp:8080",
      "tcp:8080",
    ]);
  });

  test("an unreachable device does not stop the pass; the mapping stays owned for the next one", async () => {
    const { manager, target, adbFor, advance, passes } = setup();
    await manager.ensure(target("d1"), [{ devicePort: 8080, hostPort: 8080 }]);
    await manager.ensure(target("d2"), [{ devicePort: 8080, hostPort: 8080 }]);
    adbFor("d1").failList = true;
    adbFor("d2").mappings.clear();

    await advance(INTERVAL_MS);

    expect(passes[0]?.devices).toEqual([
      {
        deviceId: "d1",
        restored: [],
        restoreFailures: [],
        error: "adb reverse --list failed on d1: device offline",
      },
      { deviceId: "d2", restored: [8080], restoreFailures: [] },
    ]);
    adbFor("d1").failList = false;
    adbFor("d1").mappings.clear();
    await advance(INTERVAL_MS);
    expect(adbFor("d1").mappings.get(8080)).toBe("tcp:8080");
  });

  test("dispose cancels the timer, waits for a running pass, and never re-arms", async () => {
    const { timer, manager, reconciler, target, adbFor, advance, unsubscribe } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    const adb = adbFor();
    adb.mappings.clear();
    let openGate = () => {};
    adb.addGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    await advance(INTERVAL_MS);
    let disposed = false;
    const disposal = reconciler.dispose().then(() => {
      disposed = true;
    });
    await drainMicrotasks(10);
    expect(disposed).toBe(false);

    openGate();
    await disposal;
    expect(disposed).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);

    // Later ownership changes no longer wake a disposed reconciler.
    unsubscribe();
    await manager.ensure(target(), [{ devicePort: 9090, hostPort: 9090 }]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
