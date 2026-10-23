import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../../src/models";
import { AdbPowerClient } from "../../../../src/features/utility/power/AndroidPowerClient";
import {
  createPowerOperations,
  type PowerMutation,
  type PowerDeviceStateDependencies,
} from "../../../../src/features/utility/power/PowerOperations";
import type { PowerTarget } from "../../../../src/features/utility/power/PowerPlan";
import { PowerRegistry } from "../../../../src/features/utility/power/PowerRegistry";
import { defaultDeviceTraits } from "../../../../src/utils/android-cmdline-tools/deviceTraits";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakePowerAdb } from "../../../fakes/FakePowerAdb";
import { FakeTimer } from "../../../fakes/FakeTimer";

import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { sequenceBackoff } from "../../../../src/utils/Backoff";
import { logger } from "../../../../src/utils/logger";

const DEVICE: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const APP = "com.example.app";

function setup(
  options: {
    target?: PowerTarget;
    owner?: string;
    platform?: "android" | "ios";
    settle?: PowerDeviceStateDependencies["settle"];
  } = {},
) {
  const adb = new FakePowerAdb();
  const registry = new PowerRegistry();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const mutation: PowerMutation = (run) => run(options.owner);
  const device = options.platform ? { ...DEVICE, platform: options.platform } : DEVICE;
  const ops = createPowerOperations(
    () => device,
    () => new FakeAdbClientFactory(adb),
    () => defaultDeviceTraits,
    () => timer,
    {
      clientFactory: () => new AdbPowerClient(adb),
      registry,
      target: async () => options.target ?? { isEmulator: true, sdk: 34 },
      mutation,
      settle: options.settle,
    },
  );
  const mutating = (): string[] =>
    adb
      .getExecutedArgv()
      .map((argv) => argv.slice(1).join(" "))
      .filter((command) =>
        /^(dumpsys (battery (set|unplug|reset)|deviceidle (force|unforce))|settings put|cmd .* (set|override|reset)|am set|input)/.test(
          command,
        ),
      );
  return { adb, registry, ops, timer, mutating };
}

describe("PowerOperations.read", () => {
  test("reads battery, doze, saver, data saver and thermal", async () => {
    const { ops } = setup();
    const state = await ops.read();
    expect(state).toMatchObject({
      supported: true,
      battery: { level: 100, charging: "ac", faked: false },
      doze: { mode: "off", deep: "ACTIVE", light: "ACTIVE" },
      dataSaver: false,
      thermal: { status: 0, override: false },
    });
    expect(state.batterySaver).toBeUndefined();
    expect(state.unreadable).toBeUndefined();
  });

  test("skips controls the API level lacks and lists failed probes as unreadable", async () => {
    const { ops, adb } = setup({ target: { isEmulator: true, sdk: 26 } });
    adb.failing.add("dumpsys deviceidle get");
    const state = await ops.read();
    expect(state.thermal).toBeUndefined();
    expect(state.unreadable).toEqual(["doze"]);
    expect(state.battery).toBeDefined();
  });

  test("is unsupported on iOS", async () => {
    const { ops } = setup({ platform: "ios" });
    expect(await ops.read()).toMatchObject({ supported: false });
  });
});

describe("PowerOperations.write", () => {
  test("applies each field, reads it back and returns the receipt", async () => {
    const { ops, adb } = setup({ owner: "s-1" });
    const state = await ops.write({
      battery: { level: 15, charging: "usb" },
      batterySaver: true,
      dataSaver: true,
      thermalStatus: 3,
      standbyBucket: { appId: APP, bucket: "restricted" },
      appInactive: { appId: APP, inactive: true },
    });
    expect(state).toMatchObject({
      verified: true,
      restoreOnRelease: true,
      applied: ["battery", "batterySaver", "dataSaver", "thermal", "standby", "inactive"],
      battery: { level: 15, charging: "usb", faked: true },
      batterySaver: true,
      dataSaver: true,
      thermal: { status: 3, override: true },
      standby: [{ appId: APP, bucket: "restricted", inactive: true }],
      restoreReceipt: {
        battery: { level: 100, charging: "ac", faked: false },
        batterySaver: null,
        dataSaver: false,
        thermal: { status: 0, override: false },
        standby: { [APP]: "active" },
        inactive: { [APP]: false },
      },
    });
    expect(state.error).toBeUndefined();
    expect(adb.battery).toMatchObject({ level: 15, usb: true, ac: false, status: 2 });
  });

  test("deep Doze unplugs and turns the screen off first, and reports both", async () => {
    const { ops, adb, mutating } = setup({ owner: "s-1" });
    adb.setScreenState(true);
    const state = await ops.write({ doze: "deep" });
    expect(mutating()).toEqual([
      "dumpsys battery unplug",
      "dumpsys battery set status 3",
      "input keyevent KEYCODE_SLEEP",
      "dumpsys deviceidle force-idle deep",
    ]);
    expect(state).toMatchObject({
      verified: true,
      applied: ["battery", "screen", "doze"],
      preconditions: [
        "battery unplugged (dumpsys battery unplug)",
        "screen turned off (KEYCODE_SLEEP)",
      ],
      doze: { mode: "deep" },
    });
  });

  test("Doze on an already unplugged, screen-off device reports no preconditions", async () => {
    const { ops, adb } = setup();
    adb.setScreenState(false);
    adb.battery.ac = false;
    const state = await ops.write({ doze: "light" });
    expect(state.preconditions).toBeUndefined();
    expect(state).toMatchObject({ verified: true, doze: { mode: "light" } });
  });

  test("doze off after deep Doze wakes the screen and puts back the plug it took", async () => {
    const { ops, adb, mutating } = setup({ owner: "s-1" });
    adb.idleLingersWhileAsleep = true;
    adb.setScreenState(true);
    await ops.write({ doze: "deep" });
    expect(adb.deep).toBe("IDLE");
    expect(adb.battery.ac).toBe(false);
    const before = mutating().length;
    const state = await ops.write({ doze: "off" });
    expect(mutating().slice(before)).toEqual([
      "dumpsys deviceidle unforce",
      "input keyevent KEYCODE_WAKEUP",
      "dumpsys battery reset",
    ]);
    expect(adb.deep).toBe("ACTIVE");
    expect(adb.battery.ac).toBe(true);
    expect(state).toMatchObject({ verified: true, doze: { mode: "off" } });
  });

  test("doze off on a device that was not dozing only unforces", async () => {
    const { ops, adb, mutating } = setup({ owner: "s-1" });
    adb.setScreenState(false);
    await ops.write({ doze: "off" });
    expect(mutating()).toEqual(["dumpsys deviceidle unforce"]);
  });

  test("Doze with a charger requested is refused before anything changes", async () => {
    const { ops, mutating } = setup();
    const state = await ops.write({ doze: "deep", battery: { charging: "ac" } });
    expect(state).toMatchObject({ errorCode: "power_doze_requires_unplugged", verified: false });
    expect(mutating()).toEqual([]);
  });

  test("Doze disabled on the build is a typed refusal", async () => {
    const { ops, adb, mutating } = setup();
    adb.deepEnabled = false;
    expect(await ops.write({ doze: "deep" })).toMatchObject({
      errorCode: "power_doze_unavailable",
    });
    expect(mutating()).toEqual([]);
  });

  test("API gates are typed errors", async () => {
    const thermal = setup({ target: { isEmulator: true, sdk: 28 } });
    expect(await thermal.ops.write({ thermalStatus: 2 })).toMatchObject({
      errorCode: "power_unsupported_api_level",
      error: expect.stringContaining("API 29+"),
    });
    const bucket = setup({ target: { isEmulator: true, sdk: 29 } });
    expect(
      await bucket.ops.write({ standbyBucket: { appId: APP, bucket: "restricted" } }),
    ).toMatchObject({
      errorCode: "power_unsupported_api_level",
      error: expect.stringContaining("API 30+"),
    });
    expect(await bucket.ops.write({ standbyBucket: { appId: APP, bucket: "rare" } })).toMatchObject(
      { verified: true },
    );
  });

  test("a physical device refuses faking but allows undoing a fake", async () => {
    const { ops, mutating } = setup({ target: { isEmulator: false, sdk: 34 } });
    for (const input of [
      { battery: { level: 5 } },
      { doze: "deep" as const },
      { thermalStatus: 4 as const },
    ]) {
      expect(await ops.write(input)).toMatchObject({ errorCode: "power_physical_device_refused" });
    }
    expect(mutating()).toEqual([]);
    expect(
      await ops.write({ battery: { reset: true }, doze: "off", thermalStatus: "reset" }),
    ).toMatchObject({
      verified: true,
    });
    expect(await ops.write({ batterySaver: true, dataSaver: true })).toMatchObject({
      verified: true,
    });
  });

  test("a field whose prior value cannot be read is not changed, others still apply", async () => {
    const { ops, adb } = setup({ owner: "s-1" });
    adb.failing.add("cmd netpolicy get");
    const state = await ops.write({ dataSaver: true, batterySaver: true });
    expect(state).toMatchObject({
      errorCode: "power_baseline_unreadable",
      verified: false,
      applied: ["batterySaver"],
    });
    expect(adb.restrictBackground).toBe(false);
    expect(adb.lowPower).toBe("1");
  });

  test("a failing command is reported and the remaining fields still apply", async () => {
    const { ops, adb } = setup();
    adb.failing.add("override-status");
    const state = await ops.write({ thermalStatus: 3, dataSaver: true });
    expect(state).toMatchObject({ errorCode: "power_command_failed", applied: ["dataSaver"] });
    expect(adb.restrictBackground).toBe(true);
  });

  test("battery saver turned off by a charger is explained", async () => {
    const { ops, adb } = setup();
    adb.saverOffWhileCharging = true;
    const state = await ops.write({ batterySaver: true });
    expect(state.verified).toBe(false);
    expect(state.mismatches?.[0]).toContain("set power.battery.charging to none");
  });

  test("a sessionless write is not restored and says so", async () => {
    const { ops, registry } = setup();
    const state = await ops.write({ dataSaver: true });
    expect(state).toMatchObject({ restoreOnRelease: false, restoreReceipt: { dataSaver: false } });
    expect(state.warning).toContain("nothing restores it automatically");
    expect(registry.get(DEVICE.deviceId)).toBeUndefined();
  });

  test("a session keeps the first prior value across writes", async () => {
    const { ops, registry } = setup({ owner: "s-1" });
    await ops.write({ batterySaver: true });
    await ops.write({ batterySaver: false });
    expect(registry.get(DEVICE.deviceId)?.baseline.batterySaver).toBeNull();
    expect(registry.get(DEVICE.deviceId)?.changed).toEqual(["batterySaver"]);
  });
});

const idleReads = (adb: FakePowerAdb): number =>
  adb.getExecutedArgv().filter((argv) => argv.join(" ").includes("deviceidle get")).length;

function transientSetup(settle?: PowerDeviceStateDependencies["settle"]) {
  const fixture = setup({ settle });
  fixture.adb.deep = "IDLE";
  fixture.adb.light = "OVERRIDE";
  return fixture;
}

describe("PowerOperations Doze settlement", () => {
  test("doze off waits for transient IDLE/OVERRIDE using default backoff", async () => {
    const { ops, adb, timer } = transientSetup();
    adb.idleSettleReads = 2;
    const state = await ops.write({ doze: "off" });
    expect(state.verified).toBe(true);
    expect(state.doze?.mode).toBe("off");
    expect(state.mismatches).toBeUndefined();
    expect(timer.getSleepHistory()).toEqual([250, 500]);
    expect(idleReads(adb)).toBe(10); // three existing read pairs plus two polls
  });

  test("budget exhaustion reports the observed state and poll count", async () => {
    const { ops, adb, timer } = transientSetup({
      defaultBudgetMs: 1000,
      backoff: sequenceBackoff([250, 500, 2000]),
    });
    adb.idleSettleReads = 1000;
    const state = await ops.write({ doze: "off" });
    expect(state.verified).toBe(false);
    expect(state.doze).toEqual({ mode: "deep", deep: "IDLE", light: "OVERRIDE" });
    expect(state.mismatches?.[0]).toContain("deep IDLE, light OVERRIDE");
    expect(state.mismatches?.[0]).toContain("still not settled after 3 reads over 1000 ms");
    expect(timer.getSleepHistory()).toEqual([250, 500, 250]);
    expect(idleReads(adb)).toBe(12);
  });

  test("ambient deadline reserves half the remaining time", async () => {
    const { ops, adb, timer } = transientSetup();
    adb.idleSettleReads = 1000;
    const deadline = timer.now() + 2000;
    const state = await runWithAbortSignal(undefined, () => ops.write({ doze: "off" }), {
      getDeadlineMs: () => deadline,
      textState: { dispatched: () => () => {} },
    });
    expect(state.verified).toBe(false);
    expect(timer.getSleepHistory()).toEqual([250, 500, 250]);
    expect(state.mismatches?.[0]).toContain("3 reads over 1000 ms");
  });

  test("a long ambient deadline is capped at the default budget", async () => {
    const { ops, adb, timer } = transientSetup({
      defaultBudgetMs: 1000,
      backoff: sequenceBackoff([250, 500, 2000]),
    });
    adb.idleSettleReads = 1000;
    const deadline = timer.now() + 10 * 60_000;
    const state = await runWithAbortSignal(undefined, () => ops.write({ doze: "off" }), {
      getDeadlineMs: () => deadline,
      textState: { dispatched: () => () => {} },
    });
    expect(state.verified).toBe(false);
    expect(timer.getSleepHistory()).toEqual([250, 500, 250]);
  });

  test("already settled snapshot has no extra reads or sleeps", async () => {
    const { ops, adb, timer } = setup();
    const state = await ops.write({ doze: "off" });
    expect(state.verified).toBe(true);
    expect(idleReads(adb)).toBe(6);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("aborted signal returns the previous observation without polling", async () => {
    const { ops, adb, timer } = transientSetup();
    adb.idleSettleReads = 1000;
    const controller = new AbortController();
    controller.abort();
    const state = await runWithAbortSignal(controller.signal, () => ops.write({ doze: "off" }));
    expect(state.verified).toBe(false);
    expect(state.doze?.deep).toBe("IDLE");
    expect(idleReads(adb)).toBe(6);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("poll read failure logs and keeps the last observation", async () => {
    const { ops, adb, timer } = transientSetup();
    adb.idleSettleReads = 1000;
    const sleep = timer.sleep.bind(timer);
    const sleepSpy = spyOn(timer, "sleep").mockImplementation(async (ms) => {
      await sleep(ms);
      adb.failing.add("dumpsys deviceidle get");
      adb.failTimes.set("dumpsys deviceidle get", 1);
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const state = await ops.write({ doze: "off" });
      expect(state.verified).toBe(false);
      expect(state.doze).toEqual({ mode: "deep", deep: "IDLE", light: "OVERRIDE" });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("simulated failure"),
        expect.any(Error),
      );
      expect(timer.getSleepHistory()).toEqual([250]);
      expect(idleReads(adb)).toBe(7);
    } finally {
      warn.mockRestore();
      sleepSpy.mockRestore();
    }
  });
});
