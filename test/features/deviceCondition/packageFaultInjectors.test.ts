import { describe, expect, test } from "bun:test";
import toolDefinitions from "../../../schemas/tool-definitions.json";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  createClearPackageDataInjector,
  createDisablePackageInjector,
  resolvePackageFaultInjector,
} from "../../../src/features/deviceCondition/packageFaultInjectors";
import { deviceConditionInputSchema } from "../../../src/features/deviceCondition/DeviceConditionTypes";

const APP = "com.example.app";
const OTHER = "com.example.app2";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

type PackageState = "enabled" | "disabled";

interface PackageDevice {
  adb: FakeAdbExecutor;
  /** The Android user the app under test runs in (the one the injector must act on). */
  userId: number;
  state(name: string, userId?: number): PackageState | undefined;
  commands(): string[];
  /** Reject a later command containing `match`: the `nth` one from now (1 = the next). */
  failOn(match: string, nth: number): void;
  /** Make the next `pm disable-user` succeed without changing anything. */
  ignoreNextDisable(): void;
  uninstall(name: string): void;
  clearOutput(output: string): void;
}

/** A device whose `pm list packages`, `pm disable-user`, `pm enable` and `pm clear` agree about its packages. */
function packageDevice(
  initial: Record<string, PackageState>,
  options: { userId?: number; otherUsers?: Record<number, Record<string, PackageState>> } = {},
): PackageDevice {
  const adb = new FakeAdbExecutor();
  const log: string[] = [];
  const userId = options.userId ?? 0;
  const users = new Map<number, Map<string, PackageState>>([
    [userId, new Map(Object.entries(initial))],
    ...Object.entries(options.otherUsers ?? {}).map(
      ([id, pkgs]) => [Number(id), new Map(Object.entries(pkgs))] as const,
    ),
  ]);
  const packages = users.get(userId)!;
  let ignoreDisable = false;
  let clearReply = "Success";
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
    // The real `pm list packages <filter>` matches a substring, which the injector must not trust.
    const list = /^shell pm list packages --user (\d+)( -d)? (\S+)$/.exec(command);
    if (list !== null) {
      const [, user, disabledOnly, filter] = list;
      const lines = [...(users.get(Number(user)) ?? [])]
        .filter(([name, state]) => name.includes(filter) && (!disabledOnly || state === "disabled"))
        .map(([name]) => `package:${name}`);
      return Promise.resolve(execResult(lines.join("\n")));
    }
    const pm = /^shell pm (disable-user|enable) --user (\d+) (\S+)$/.exec(command);
    if (pm !== null) {
      const [, action, user, name] = pm;
      const pkgs = users.get(Number(user));
      if (action === "disable-user" && ignoreDisable) {
        ignoreDisable = false;
      } else if (pkgs?.has(name)) {
        pkgs.set(name, action === "enable" ? "enabled" : "disabled");
      }
      return Promise.resolve(execResult(""));
    }
    if (command.startsWith("shell pm clear ")) {
      return Promise.resolve(execResult(clearReply));
    }
    return Promise.resolve(execResult(""));
  };

  return {
    adb,
    userId,
    state: (name, id = userId) => users.get(id)?.get(name),
    commands: () => log,
    failOn: (match, nth) => {
      scheduled.push({ match, skip: nth - 1 });
    },
    ignoreNextDisable: () => {
      ignoreDisable = true;
    },
    uninstall: (name) => {
      packages.delete(name);
    },
    clearOutput: (output) => {
      clearReply = output;
    },
  };
}

const target = (name: string) => ({ package: name });
const pmWrites = (device: PackageDevice) =>
  device.commands().filter((c) => /^shell pm (disable-user|enable|clear) /.test(c));

describe("faults.disablePackage (#14069)", () => {
  test("disables the app, reads it back, and reset re-enables it", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    const outcome = await injector.apply("apply", undefined, target(APP));
    expect(outcome.status).toBe("applied");
    expect(device.state(APP)).toBe("disabled");
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(device.state(APP)).toBe("enabled");
    expect(await injector.isClean()).toBe(true);
  });

  test("matches the package exactly, not as a substring of another", async () => {
    const device = packageDevice({ [OTHER]: "enabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    await expect(injector.apply("apply", undefined, target(APP))).rejects.toThrow(
      /is not installed/,
    );
    expect(pmWrites(device)).toEqual([]);
  });

  test("an app already disabled is left alone and never re-enabled", async () => {
    const device = packageDevice({ [APP]: "disabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    const outcome = await injector.apply("apply", undefined, target(APP));
    expect(outcome.status).toBe("unchanged");
    expect(outcome.reset).toBeUndefined();
    expect(pmWrites(device)).toEqual([]);
  });

  test("a disable that does not take effect is unsupported and rolled back", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    device.ignoreNextDisable();
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    await expect(injector.apply("apply", undefined, target(APP))).rejects.toThrow(
      /did not disable/,
    );
    expect(pmWrites(device)).toEqual([
      `shell pm disable-user --user 0 ${APP}`,
      `shell pm enable --user 0 ${APP}`,
    ]);
    expect(await injector.isClean()).toBe(true);
  });

  test("a failed disable whose rollback also fails hands the reset to the controller", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    // The disable takes effect, the read-back after it fails, and so does the rollback's enable.
    device.failOn("pm list packages --user 0 -d", 2);
    device.failOn("pm enable", 1);
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    const failure = await injector.apply("apply", undefined, target(APP)).catch((e) => e);
    expect(failure).toBeInstanceOf(OwedResetError);
    expect(device.state(APP)).toBe("disabled");
    await (failure as OwedResetError).owedReset();
    expect(device.state(APP)).toBe("enabled");
  });

  test("several disabled apps are re-enabled newest first and a failure stays owed", async () => {
    const device = packageDevice({ [APP]: "enabled", [OTHER]: "enabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    await injector.apply("apply", undefined, target(APP));
    const second = await injector.apply("apply", undefined, target(OTHER));
    device.failOn(`pm enable --user 0 ${OTHER}`, 1);
    await expect(second.reset?.()).rejects.toThrow(/Could not re-enable/);
    expect(device.state(APP)).toBe("enabled");
    expect(device.state(OTHER)).toBe("disabled");
    expect(device.commands().filter((c) => c.startsWith("shell pm enable "))).toEqual([
      `shell pm enable --user 0 ${OTHER}`,
      `shell pm enable --user 0 ${APP}`,
    ]);
    expect(await injector.isClean()).toBe(false);
    await second.reset?.();
    expect(device.state(OTHER)).toBe("enabled");
  });

  test("re-applying an app it already disabled keeps the reset and does not disable twice", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    await injector.apply("apply", undefined, target(APP));
    const again = await injector.apply("apply", undefined, target(APP));
    expect(again.status).toBe("unchanged");
    expect(again.reset).toBeDefined();
    expect(pmWrites(device)).toEqual([`shell pm disable-user --user 0 ${APP}`]);
  });

  test("acts on the app's own Android user, not user 0", async () => {
    const device = packageDevice(
      { [APP]: "enabled" },
      { userId: 10, otherUsers: { 0: { [APP]: "disabled" } } },
    );
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(10));
    const outcome = await injector.apply("apply", undefined, target(APP));
    expect(outcome.status).toBe("applied");
    expect(device.state(APP, 10)).toBe("disabled");
    expect(pmWrites(device)).toEqual([`shell pm disable-user --user 10 ${APP}`]);
    await outcome.reset?.();
    expect(device.state(APP, 10)).toBe("enabled");
    expect(device.state(APP, 0)).toBe("disabled");
  });

  test("the same app disabled for two users is re-enabled for both", async () => {
    const device = packageDevice(
      { [APP]: "enabled" },
      { otherUsers: { 10: { [APP]: "enabled" } } },
    );
    let user = 0;
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(user));
    await injector.apply("apply", undefined, target(APP));
    user = 10;
    const second = await injector.apply("apply", undefined, target(APP));
    await second.reset?.();
    expect(device.state(APP, 0)).toBe("enabled");
    expect(device.state(APP, 10)).toBe("enabled");
  });

  test("a second reset after a clean one issues no further commands", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    const outcome = await injector.apply("apply", undefined, target(APP));
    await outcome.reset?.();
    const before = device.commands().length;
    await outcome.reset?.();
    expect(device.commands().length).toBe(before);
  });

  test("reset after the app was uninstalled has nothing to restore", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    const outcome = await injector.apply("apply", undefined, target(APP));
    device.uninstall(APP);
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
    expect(pmWrites(device)).toEqual([`shell pm disable-user --user 0 ${APP}`]);
  });

  test("rejects a request without a valid package", async () => {
    const injector = createDisablePackageInjector(packageDevice({}).adb, () => Promise.resolve(0));
    await expect(injector.apply("apply", undefined, {})).rejects.toThrow(/Invalid/);
    await expect(injector.apply("apply", undefined, target("a b; rm -rf /"))).rejects.toThrow(
      /Invalid/,
    );
    await expect(injector.apply("on", undefined, target(APP))).rejects.toThrow(/Invalid/);
  });

  test("through the controller, unset re-enables", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createDisablePackageInjector(device.adb, () => Promise.resolve(device.userId));
    const controller = new DeviceConditionController((key) =>
      key === "faults.disablePackage" ? injector : undefined,
    );
    const applied = await controller.apply({ faults: { disablePackage: target(APP) } });
    expect(applied.active).toEqual(["faults.disablePackage"]);
    const cleared = await controller.apply({ faults: { disablePackage: "unset" } });
    expect(cleared.changes[0]?.status).toBe("cleared");
    expect(cleared.active).toEqual([]);
    expect(device.state(APP)).toBe("enabled");
  });
});

describe("faults.clearPackageData (#14069)", () => {
  test("clears the data once, registers no reset, and is always clean", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createClearPackageDataInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const outcome = await injector.apply("apply", undefined, target(APP));
    expect(outcome.status).toBe("applied");
    expect(outcome.reset).toBeUndefined();
    expect(outcome.detail).toContain("cannot be undone");
    expect(pmWrites(device)).toEqual([`shell pm clear --user 0 ${APP}`]);
    expect(await injector.isClean()).toBe(true);
  });

  test("clears the data for the app's own Android user", async () => {
    const device = packageDevice({ [APP]: "enabled" }, { userId: 10 });
    const injector = createClearPackageDataInjector(device.adb, () => Promise.resolve(10));
    await injector.apply("apply", undefined, target(APP));
    expect(pmWrites(device)).toEqual([`shell pm clear --user 10 ${APP}`]);
  });

  test("refuses an uninstalled app and a clear that did not report Success", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createClearPackageDataInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    await expect(injector.apply("apply", undefined, target(OTHER))).rejects.toThrow(
      /is not installed/,
    );
    device.clearOutput("Failed");
    await expect(injector.apply("apply", undefined, target(APP))).rejects.toThrow(
      /did not report Success/,
    );
  });

  test("rejects a malformed request and leaves 'unset' a no-op through the controller", async () => {
    const device = packageDevice({ [APP]: "enabled" });
    const injector = createClearPackageDataInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    await expect(injector.apply("apply", undefined, undefined)).rejects.toThrow(/Invalid/);
    const controller = new DeviceConditionController((key) =>
      key === "faults.clearPackageData" ? injector : undefined,
    );
    const result = await controller.apply({ faults: { clearPackageData: "unset" } });
    expect(result.changes[0]?.status).toBe("unchanged");
    expect(pmWrites(device)).toEqual([]);
  });
});

describe("package faults in the request and resolver", () => {
  test("the schema accepts a package object or unset and rejects anything else", () => {
    const parse = (faults: unknown) => deviceConditionInputSchema.safeParse({ faults }).success;
    expect(parse({ disablePackage: target(APP), clearPackageData: "unset" })).toBe(true);
    expect(parse({ disablePackage: "on" })).toBe(false);
    expect(parse({ clearPackageData: { package: "nodots" } })).toBe(false);
    expect(parse({ disablePackage: { package: APP, user: 10 } })).toBe(false);
  });

  test("the advertised deviceCondition schema inlines the package object instead of referencing it", () => {
    const setDeviceState = toolDefinitions.find((tool) => tool.name === "setDeviceState");
    const deviceCondition = JSON.stringify(
      (setDeviceState?.inputSchema as { properties: Record<string, unknown> }).properties
        .deviceCondition,
    );
    expect(deviceCondition).toContain("clearPackageData");
    // Reusing one zod instance for two fields emits a $ref the embedded schema cannot resolve.
    expect(deviceCondition).not.toContain("$ref");
  });

  test("caches one injector per device and key and ignores other keys and platforms", () => {
    const adb = packageDevice({}).adb;
    const cache = new Map();
    const deps = { adbFactory: { create: () => adb }, cache };
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const disable = resolvePackageFaultInjector(android, "faults.disablePackage", deps);
    const clear = resolvePackageFaultInjector(android, "faults.clearPackageData", deps);
    expect(disable?.key).toBe("faults.disablePackage");
    expect(clear?.key).toBe("faults.clearPackageData");
    expect(resolvePackageFaultInjector(android, "faults.disablePackage", deps)).toBe(disable);
    expect(resolvePackageFaultInjector(android, "faults.storage", deps)).toBeUndefined();
    expect(
      resolvePackageFaultInjector(
        { name: "iPhone", platform: "ios", deviceId: "SIM" },
        "faults.disablePackage",
        deps,
      ),
    ).toBeUndefined();
  });
});
