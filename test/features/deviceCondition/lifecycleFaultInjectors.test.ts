import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  createDontKeepActivitiesFaultInjector,
  resolveLifecycleFaultInjector,
} from "../../../src/features/deviceCondition/lifecycleFaultInjectors";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

const SETTING = "always_finish_activities";

interface SettingsAdb {
  adb: FakeAdbExecutor;
  /** The current value of the setting; "null" when it is unset. */
  value(): string;
  commands(): string[];
  /** Make reads report this value instead of the stored one (something else flipped the setting). */
  readAs(value: string | undefined): void;
  /** Reject the next `settings put`. */
  failNextPut(): void;
  /** Swallow the next `settings put` without changing the value, the way a flaky settings provider can. */
  ignoreNextPut(): void;
  /** Reject a later command containing `match`: the `nth` one from now (1 = the next). */
  failOn(match: string, nth: number): void;
}

/**
 * A device whose `settings` command stores one global value, so apply/reset/read-back
 * run against real state. `persists: false` makes `settings put` a silent no-op, and
 * `failNext` rejects the next command containing the given text.
 */
function settingsAdb(
  initial: string,
  options: { persists?: boolean; failNext?: string } = {},
): SettingsAdb {
  const adb = new FakeAdbExecutor();
  const log: string[] = [];
  let current = initial;
  let failNext = options.failNext;
  let readOverride: string | undefined;
  let failPut = false;
  let ignorePut = false;
  const scheduled: { match: string; skip: number }[] = [];
  adb.execute = (args) => {
    const command = args.join(" ");
    log.push(command);
    for (const entry of [...scheduled]) {
      if (command.includes(entry.match)) {
        if (entry.skip > 0) {
          entry.skip -= 1;
        } else {
          scheduled.splice(scheduled.indexOf(entry), 1);
          return Promise.reject(new Error("adb offline"));
        }
      }
    }
    if (failNext !== undefined && command.includes(failNext)) {
      failNext = undefined;
      return Promise.reject(new Error("adb offline"));
    }
    if (command === `shell settings get global ${SETTING}`) {
      return Promise.resolve(execResult(readOverride ?? current));
    }
    if (command.startsWith(`shell settings put global ${SETTING} `)) {
      if (failPut) {
        failPut = false;
        return Promise.reject(new Error("adb offline"));
      }
      if (ignorePut) {
        ignorePut = false;
      } else if (options.persists !== false) {
        current = args[args.length - 1];
      }
    } else if (command === `shell settings delete global ${SETTING}`) {
      current = "null";
    }
    return Promise.resolve(execResult(""));
  };
  return {
    adb,
    value: () => current,
    commands: () => [...log],
    readAs: (value) => {
      readOverride = value;
    },
    failNextPut: () => {
      failPut = true;
    },
    ignoreNextPut: () => {
      ignorePut = true;
    },
    failOn: (match, nth) => {
      scheduled.push({ match, skip: nth - 1 });
    },
  };
}

const writes = (commands: string[]): string[] =>
  commands.filter((c) => /settings (put|delete)/.test(c));

describe("dontKeepActivities fault (#14068)", () => {
  test("applies, then reset restores the prior value and reads clean", async () => {
    const device = settingsAdb("0");
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const outcome = await injector.apply("on");
    expect(outcome.status).toBe("applied");
    expect(device.value()).toBe("1");
    expect(await injector.isClean()).toBe(false);

    await outcome.reset?.();
    expect(device.value()).toBe("0");
    expect(await injector.isClean()).toBe(true);
  });

  test("deletes the setting on reset when it was unset before", async () => {
    const device = settingsAdb("null");
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const outcome = await injector.apply("on");
    expect(device.value()).toBe("1");
    await outcome.reset?.();
    expect(device.value()).toBe("null");
  });

  test("a repeat apply keeps the original baseline and registers no second reset", async () => {
    const device = settingsAdb("0");
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const first = await injector.apply("on");
    const second = await injector.apply("on");
    expect(second.status).toBe("unchanged");
    expect(second.reset).toBeUndefined();

    await first.reset?.();
    // Had the second apply recorded the fault's own "1" as the baseline, this would stay 1.
    expect(device.value()).toBe("0");
  });

  test("re-asserts the setting on a repeat apply when something switched it off", async () => {
    const device = settingsAdb("0");
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const first = await injector.apply("on");
    device.readAs("0");

    const second = await injector.apply("on");
    expect(second.status).toBe("unchanged");
    expect(writes(device.commands()).filter((c) => c.endsWith(" 1"))).toHaveLength(2);
    device.readAs(undefined);
    await first.reset?.();
    expect(device.value()).toBe("0");
  });

  test("leaves a setting that was already on alone and never takes ownership of it", async () => {
    const device = settingsAdb("1");
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const outcome = await injector.apply("on");
    expect(outcome.status).toBe("unchanged");
    expect(outcome.reset).toBeUndefined();
    expect(writes(device.commands())).toEqual([]);
  });

  test("a failed baseline read changes nothing", async () => {
    const device = settingsAdb("0", { failNext: "settings get" });
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    await expect(injector.apply("on")).rejects.toThrow();
    expect(writes(device.commands())).toEqual([]);
    expect(device.value()).toBe("0");
  });

  test("a write that does not take effect is reported unsupported and owns nothing", async () => {
    const device = settingsAdb("0", { persists: false });
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    await expect(injector.apply("on")).rejects.toThrow(/unsupported on this image/);
    expect(await injector.isClean()).toBe(true);
  });

  test("a reset that fails keeps the fault owed so a retry restores it", async () => {
    const device = settingsAdb("0");
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const outcome = await injector.apply("on");
    device.failNextPut();

    await expect(outcome.reset?.()).rejects.toThrow();
    expect(device.value()).toBe("1");
    await outcome.reset?.();
    expect(device.value()).toBe("0");
  });

  test("a restore write that is silently ignored keeps the fault owed until a retry verifies it", async () => {
    const device = settingsAdb("0");
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const outcome = await injector.apply("on");
    device.ignoreNextPut();

    await expect(outcome.reset?.()).rejects.toThrow(/did not take effect/);
    expect(device.value()).toBe("1");
    expect(await injector.isClean()).toBe(false);

    // The retry must issue a fresh write; with the baseline dropped it would be a no-op.
    await outcome.reset?.();
    expect(device.value()).toBe("0");
    expect(await injector.isClean()).toBe(true);
  });

  test("a failed verification read after a successful write is rolled back", async () => {
    const device = settingsAdb("0");
    // Reads: 1 = baseline, 2 = verification (fails), 3 = rollback read-back.
    device.failOn("settings get", 2);
    const injector = createDontKeepActivitiesFaultInjector(device.adb);

    await expect(injector.apply("on")).rejects.toThrow(/adb offline/);
    expect(device.value()).toBe("0");
    expect(await injector.isClean()).toBe(true);
  });

  test("when the rollback fails too, the owed reset still restores the setting", async () => {
    const device = settingsAdb("0");
    device.failOn("settings get", 2);
    device.failOn("settings put", 2);
    const injector = createDontKeepActivitiesFaultInjector(device.adb);

    const error = await injector.apply("on").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwedResetError);
    expect(device.value()).toBe("1");

    await (error as OwedResetError).owedReset();
    expect(device.value()).toBe("0");
    expect(await injector.isClean()).toBe(true);
  });

  test("the controller registers the owed reset when apply and rollback both fail", async () => {
    const device = settingsAdb("0");
    device.failOn("settings get", 2);
    device.failOn("settings put", 2);
    const injector = createDontKeepActivitiesFaultInjector(device.adb);
    const controller = new DeviceConditionController(() => injector);

    const result = await controller.apply({ faults: { dontKeepActivities: "on" } });
    expect(result.success).toBe(false);
    expect(result.active).toEqual(["faults.dontKeepActivities"]);

    const restored = await controller.restore();
    expect(restored.verifiedClean).toBe(true);
    expect(device.value()).toBe("0");
  });

  test("rejects an unknown value before touching the device", async () => {
    const device = settingsAdb("0");
    await expect(createDontKeepActivitiesFaultInjector(device.adb).apply("maybe")).rejects.toThrow(
      /Invalid faults.dontKeepActivities/,
    );
    expect(device.commands()).toEqual([]);
  });

  test("works through the controller: apply, then unset restores and verifies clean", async () => {
    const device = settingsAdb("0");
    const controller = new DeviceConditionController((key) =>
      key === "faults.dontKeepActivities"
        ? createDontKeepActivitiesFaultInjector(device.adb)
        : undefined,
    );
    const applied = await controller.apply({ faults: { dontKeepActivities: "on" } });
    expect(applied.success).toBe(true);
    expect(applied.active).toEqual(["faults.dontKeepActivities"]);

    const restored = await controller.restore();
    expect(restored.verifiedClean).toBe(true);
    expect(device.value()).toBe("0");
  });

  test("the resolver serves only this key, only on Android", () => {
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    const factory = { create: () => new FakeAdbExecutor() };
    expect(
      resolveLifecycleFaultInjector(android, "faults.dontKeepActivities", { adbFactory: factory })
        ?.key,
    ).toBe("faults.dontKeepActivities");
    expect(
      resolveLifecycleFaultInjector(android, "faults.battery", { adbFactory: factory }),
    ).toBeUndefined();
    expect(
      resolveLifecycleFaultInjector(ios, "faults.dontKeepActivities", { adbFactory: factory }),
    ).toBeUndefined();
  });
});
