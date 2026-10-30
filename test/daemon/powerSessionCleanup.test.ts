import { describe, expect, spyOn, test } from "bun:test";
import {
  powerRestoreResult,
  registerPowerSessionCleanup,
  startPowerRestore,
} from "../../src/daemon/powerSessionCleanup";
import { AdbPowerClient } from "../../src/features/utility/power/AndroidPowerClient";
import { createPowerOperations } from "../../src/features/utility/power/PowerOperations";
import { PowerRegistry } from "../../src/features/utility/power/PowerRegistry";
import { createSessionPowerMutation } from "../../src/server/sessionPower";
import { defaultDeviceTraits } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { logger } from "../../src/utils/logger";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakePowerAdb } from "../fakes/FakePowerAdb";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const APP = "com.example.app";

function setup() {
  const adb = new FakePowerAdb();
  const registry = new PowerRegistry();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const manager = new FakeSessionCleanupManager();
  const options = { registry, timer, clientFactory: () => new AdbPowerClient(adb) };
  registerPowerSessionCleanup(manager, options);
  const ops = createPowerOperations(
    () => ({ name: "emu", platform: "android", deviceId: DEVICE }),
    () => new FakeAdbClientFactory(adb),
    () => defaultDeviceTraits,
    {
      timer: () => timer,
      seams: {
        clientFactory: options.clientFactory,
        registry,
        target: async () => ({ isEmulator: true, sdk: 34 }),
        mutation: (run) => run("s-1"),
      },
    },
  );
  const mutating = () =>
    adb
      .getExecutedArgv()
      .map((argv) => argv.slice(1).join(" "))
      .filter((command) =>
        /^(dumpsys (battery (set|unplug|reset)|deviceidle (force|unforce))|settings put|cmd .* (set|override|reset)|am set|input)/.test(
          command,
        ),
      );
  return { adb, registry, timer, manager, ops, options, mutating };
}

const everything = {
  battery: { level: 15, charging: "none" as const },
  doze: "deep" as const,
  batterySaver: true,
  dataSaver: true,
  thermalStatus: 4 as const,
  standbyBucket: { appId: APP, bucket: "restricted" as const },
  appInactive: { appId: APP, inactive: true },
};

describe("registerPowerSessionCleanup", () => {
  test("release restores battery, Doze, screen, saver, data saver, thermal and standby, newest first", async () => {
    const { adb, manager, ops, options, mutating } = setup();
    adb.setScreenState(true);
    const state = await ops.write(everything);
    expect(state).toMatchObject({ verified: true, doze: { mode: "deep" } });
    const applied = mutating().length;

    manager.release("s-1", DEVICE);
    await manager.settle();

    expect(mutating().slice(applied)).toEqual([
      "am set-inactive com.example.app false",
      "am set-standby-bucket com.example.app active",
      "cmd thermalservice reset",
      "cmd netpolicy set restrict-background false",
      "settings put global low_power 0",
      "dumpsys deviceidle unforce",
      "input keyevent KEYCODE_WAKEUP",
      "dumpsys battery reset",
    ]);
    expect(adb.battery).toMatchObject({ level: 100, ac: true, stopped: false });
    expect(adb.deep).toBe("ACTIVE");
    expect(adb.thermal.override).toBe(false);
    expect(adb.restrictBackground).toBe(false);
    expect(adb.lowPower).toBe("0");
    expect(adb.buckets.get(APP)).toBe(10);
    expect(await adb.isScreenOn()).toBe(true);
    expect(manager.pendingCleanups.map(({ deviceId, bound }) => [deviceId, bound])).toEqual([
      [DEVICE, { name: "restore session power state", leftover: expect.any(String) }],
    ]);
    const { powerRestore } = await powerRestoreResult("s-1", options);
    expect(powerRestore).toMatchObject({ status: "restored", deviceId: DEVICE });
    expect(
      powerRestore && "fields" in powerRestore && powerRestore.fields.map((f) => f.field),
    ).toEqual([
      "inactive",
      "standby",
      "thermal",
      "dataSaver",
      "batterySaver",
      "doze",
      "screen",
      "battery",
    ]);
    expect(
      powerRestore && "fields" in powerRestore && powerRestore.fields.every((f) => f.verified),
    ).toBe(true);
  });

  test("an unforced Doze is left before the battery is replugged, even when set in later calls", async () => {
    const { adb, manager, ops, mutating } = setup();
    adb.setScreenState(false);
    await ops.write({ batterySaver: true });
    await ops.write({ doze: "light" });
    manager.release("s-1", DEVICE);
    await manager.settle();
    const restore = mutating().filter((c) => /unforce|battery reset/.test(c));
    expect(restore).toEqual(["dumpsys deviceidle unforce", "dumpsys battery reset"]);
  });

  test("a Doze restore that deviceidle reports late is polled with backoff, not re-applied (#15042)", async () => {
    const { adb, manager, ops, options, timer, mutating } = setup();
    await ops.write({ doze: "deep" });
    adb.idleSettleReads = 3;

    manager.release("s-1", DEVICE);
    await manager.settle();

    expect(mutating().filter((c) => c.includes("deviceidle unforce"))).toEqual([
      "dumpsys deviceidle unforce",
    ]);
    expect(timer.getSleepHistory()).toEqual(expect.arrayContaining([250, 500, 1000]));
    const { powerRestore } = await powerRestoreResult("s-1", options);
    expect(
      powerRestore &&
        "fields" in powerRestore &&
        powerRestore.fields.find((f) => f.field === "doze"),
    ).toEqual({ field: "doze", status: "restored", verified: true });
  });

  test("a deep Doze on an awake device releases restored and verified, with one wake (#15161)", async () => {
    const { adb, manager, ops, options, timer, mutating } = setup();
    // The emulator keeps forced idle after unforce until the screen it put to sleep wakes.
    adb.idleLingersWhileAsleep = true;
    adb.setScreenState(true);
    await ops.write({ doze: "deep" });
    expect(adb.deep).toBe("IDLE");
    expect(await adb.isScreenOn()).toBe(false);
    const applied = mutating().length;

    manager.release("s-1", DEVICE);
    await manager.settle();

    expect(mutating().slice(applied)).toEqual([
      "dumpsys deviceidle unforce",
      "input keyevent KEYCODE_WAKEUP",
      "dumpsys battery reset",
    ]);
    expect(adb.deep).toBe("ACTIVE");
    // Settled on the first read-back: no backoff wait for an idle state that could never clear.
    expect(timer.getSleepHistory()).toEqual([]);
    const { powerRestore } = await powerRestoreResult("s-1", options);
    expect(powerRestore).toMatchObject({
      status: "restored",
      fields: [
        { field: "doze", status: "restored", verified: true },
        { field: "screen", status: "restored", verified: true },
        { field: "battery", status: "restored", verified: true },
      ],
    });
    expect(powerRestore).not.toHaveProperty("leftover");
  });

  test("a failed wake before the Doze read-back does not fail the Doze restore (#15161)", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { adb, manager, ops, options } = setup();
      adb.idleLingersWhileAsleep = true;
      adb.setScreenState(true);
      await ops.write({ doze: "deep" });
      adb.failing.add("KEYCODE_WAKEUP");
      adb.failTimes.set("KEYCODE_WAKEUP", 1);

      manager.release("s-1", DEVICE);
      await manager.settle();

      const { powerRestore } = await powerRestoreResult("s-1", options);
      expect(powerRestore).toMatchObject({
        status: "restored",
        fields: [
          { field: "doze", status: "restored", verified: true },
          { field: "screen", status: "restored", verified: true },
          { field: "battery", status: "restored", verified: true },
        ],
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("one failing field does not stop the others and the failure is reported loudly", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { adb, manager, ops, options } = setup();
      adb.setScreenState(false);
      await ops.write({ thermalStatus: 2, dataSaver: true, batterySaver: true });
      adb.failing.add("cmd thermalservice reset");

      manager.release("s-1", DEVICE);
      await manager.settle();

      expect(adb.restrictBackground).toBe(false);
      expect(adb.lowPower).toBe("0");
      expect(adb.thermal.override).toBe(true);
      const { powerRestore } = await powerRestoreResult("s-1", options);
      expect(powerRestore).toMatchObject({
        status: "partial",
        fields: [
          { field: "batterySaver", status: "restored" },
          { field: "dataSaver", status: "restored" },
          {
            field: "thermal",
            status: "failed",
            error: expect.stringContaining("simulated failure"),
          },
        ].reverse(),
        leftover: expect.stringContaining(
          "thermal (adb -s emulator-5554 shell cmd thermalservice reset)",
        ),
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a transient failure is retried after a delay", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { adb, manager, ops, options, timer } = setup();
      await ops.write({ dataSaver: true });
      adb.failing.add("restrict-background false");
      adb.failTimes.set("restrict-background false", 1);

      manager.release("s-1", DEVICE);
      await manager.settle();

      expect(timer.getSleepHistory()).toContain(1000);
      expect(adb.restrictBackground).toBe(false);
      expect((await powerRestoreResult("s-1", options)).powerRestore).toMatchObject({
        status: "restored",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("a battery faked before the session is put back as it was, not reset", async () => {
    const { adb, manager, ops } = setup();
    adb.battery = { level: 40, ac: false, usb: false, wireless: false, status: 3, stopped: true };
    await ops.write({ battery: { level: 90, charging: "usb" } });
    manager.release("s-1", DEVICE);
    await manager.settle();
    expect(adb.battery).toMatchObject({ level: 40, ac: false, usb: false, stopped: true });
  });

  test("a standby bucket a shell cannot set back is skipped, not failed", async () => {
    const { adb, manager, ops, options } = setup();
    adb.buckets.set(APP, 5);
    await ops.write({ standbyBucket: { appId: APP, bucket: "rare" } });
    manager.release("s-1", DEVICE);
    await manager.settle();
    expect((await powerRestoreResult("s-1", options)).powerRestore).toMatchObject({
      status: "skipped",
      fields: [{ field: "standby", status: "skipped" }],
    });
  });

  test("a replaced device is not touched", async () => {
    const { adb, manager, ops, options, registry } = setup();
    await ops.write({ dataSaver: true });
    const before = adb.getExecutedArgv().length;
    manager.release("s-1", DEVICE, false, true);
    expect(adb.getExecutedArgv()).toHaveLength(before);
    expect((await powerRestoreResult("s-1", options)).powerRestore).toMatchObject({
      status: "skipped",
    });
    expect(registry.get(DEVICE)).toBeUndefined();
  });

  test("another session's release, an upgrade-only release and a plain device leave state alone", async () => {
    const { adb, manager, ops } = setup();
    await ops.write({ dataSaver: true });
    manager.release("s-2", DEVICE);
    manager.release("s-1", DEVICE, true);
    await manager.settle();
    expect(adb.restrictBackground).toBe(true);
  });

  test("a rebind off the device restores it", async () => {
    const { adb, manager, ops } = setup();
    await ops.write({ dataSaver: true });
    manager.unbind("s-1", DEVICE);
    await manager.settle();
    expect(adb.restrictBackground).toBe(false);
  });

  test("a session with no power changes reports nothing", async () => {
    const { options } = setup();
    expect(await powerRestoreResult("s-9", options)).toEqual({});
  });
});

describe("startPowerRestore", () => {
  test("a throwing client factory becomes a failed report", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const manager = new FakeSessionCleanupManager();
      const report = await startPowerRestore(
        manager,
        { deviceId: DEVICE, sessionId: "s-1", baseline: {}, changed: ["doze"] },
        {
          registry: new PowerRegistry(),
          clientFactory: () => {
            throw new Error("adb missing");
          },
        },
      );
      expect(report).toMatchObject({ status: "failed", error: "adb missing" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createSessionPowerMutation", () => {
  const session = { sessionId: "s-1", assignedDevice: DEVICE };
  function host(live: { value: boolean }) {
    const manager = new FakeSessionCleanupManager();
    return {
      manager,
      host: {
        registerPendingDeviceCleanup: manager.registerPendingDeviceCleanup.bind(manager),
        getSession: () => session,
        isAdmittedForAutomation: () => live.value,
        trackSessionSetup: async (_s: typeof session, run: () => Promise<void>) => run(),
      },
    };
  }

  test("passes the owning session id to the write", async () => {
    const { host: h } = host({ value: true });
    const mutation = createSessionPowerMutation(h, "uuid", DEVICE);
    const owner = await mutation(async (id) => ({ supported: true, warning: id }));
    expect(owner.warning).toBe("s-1");
  });

  test("a sessionless call has no owner", async () => {
    const mutation = createSessionPowerMutation(undefined, undefined, DEVICE);
    expect((await mutation(async (id) => ({ supported: true, warning: String(id) }))).warning).toBe(
      "undefined",
    );
  });

  test("a released session cannot change power state", async () => {
    const { host: h } = host({ value: false });
    const mutation = createSessionPowerMutation(h, "uuid", DEVICE);
    await expect(mutation(async () => ({ supported: true }))).rejects.toThrow("released");
  });

  test("a write that finishes after the session ended is restored at once", async () => {
    const live = { value: true };
    const { adb, registry, timer, options } = setup();
    const { host: h, manager: hostManager } = host(live);
    const late = createSessionPowerMutation(h, "uuid", DEVICE, options);
    const lateOps = createPowerOperations(
      () => ({ name: "emu", platform: "android", deviceId: DEVICE }),
      () => new FakeAdbClientFactory(adb),
      () => defaultDeviceTraits,
      {
        timer: () => timer,
        seams: {
          clientFactory: options.clientFactory,
          registry,
          target: async () => ({ isEmulator: true, sdk: 34 }),
          mutation: (run) =>
            late(async (owner) => {
              const state = await run(owner);
              live.value = false;
              return state;
            }),
        },
      },
    );
    const state = await lateOps.write({ dataSaver: true });
    await hostManager.settle();
    expect(state).toMatchObject({ restoreOnRelease: false });
    expect(state.warning).toContain("being restored");
    expect(adb.restrictBackground).toBe(false);
    expect(registry.get(DEVICE)).toBeUndefined();
  });
});
