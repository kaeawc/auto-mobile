import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  createPermissionFaultInjector,
  resolvePermissionFaultInjector,
} from "../../../src/features/deviceCondition/permissionFaultInjectors";
import {
  deviceConditionChanges,
  deviceConditionInputSchema,
} from "../../../src/features/deviceCondition/DeviceConditionTypes";

const APP = "com.example.app";
const CAMERA = "android.permission.CAMERA";
const MIC = "android.permission.RECORD_AUDIO";
const INTERNET = "android.permission.INTERNET";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

interface PermissionDevice {
  adb: FakeAdbExecutor;
  /** The Android user the app under test runs in (the one the injector must act on). */
  userId: number;
  state(permission: string, userId?: number): "granted" | "denied" | undefined;
  commands(): string[];
  /** Reject a later command containing `match`: the `nth` one from now (1 = the next). */
  failOn(match: string, nth: number): void;
  /** Make the next `pm revoke` succeed without changing anything. */
  ignoreNextRevoke(): void;
  uninstall(): void;
}

interface PermissionDeviceOptions {
  /** Runtime permissions the app requests and their starting state, for the app's user. */
  runtime: Record<string, "granted" | "denied">;
  /** The user the app under test runs in; defaults to 0. */
  userId?: number;
  /** The same app's permissions for other users, which must not be read or changed. */
  otherUsers?: Record<number, Record<string, "granted" | "denied">>;
  installed?: boolean;
}

/** A device whose `dumpsys package`, `pm revoke` and `pm grant` agree about one app's permissions. */
function permissionDevice(options: PermissionDeviceOptions): PermissionDevice {
  const adb = new FakeAdbExecutor();
  const log: string[] = [];
  const userId = options.userId ?? 0;
  const users = new Map<number, Map<string, "granted" | "denied">>([
    [userId, new Map(Object.entries(options.runtime))],
    ...Object.entries(options.otherUsers ?? {}).map(
      ([id, perms]) => [Number(id), new Map(Object.entries(perms))] as const,
    ),
  ]);
  const runtime = users.get(userId)!;
  let installed = options.installed ?? true;
  let ignoreRevoke = false;
  const scheduled: { match: string; skip: number }[] = [];

  const dump = (): string => {
    if (!installed) {
      return "Packages:\n";
    }
    const requested = [INTERNET, ...runtime.keys()].map((p) => `      ${p}`).join("\n");
    const userSections = [...users].flatMap(([id, perms]) => [
      `    User ${id}: ceDataInode=1 installed=true`,
      "      runtime permissions:",
      ...[...perms].map(([p, s]) => `        ${p}: granted=${s === "granted"}, flags=[ USER_SET ]`),
    ]);
    return [
      "Packages:",
      `  Package [${APP}] (abc123):`,
      "    requested permissions:",
      requested,
      "    install permissions:",
      `      ${INTERNET}: granted=true`,
      ...userSections,
    ].join("\n");
  };

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
    const pm = /^shell pm (grant|revoke) --user (\d+) (\S+) (\S+)$/.exec(command);
    if (pm !== null) {
      const [, action, user, , permission] = pm;
      const perms = users.get(Number(user));
      if (action === "revoke" && ignoreRevoke) {
        ignoreRevoke = false;
      } else if (perms?.has(permission)) {
        perms.set(permission, action === "grant" ? "granted" : "denied");
      }
      return Promise.resolve(execResult(""));
    }
    if (command === `shell dumpsys package ${APP}`) {
      return Promise.resolve(execResult(dump()));
    }
    return Promise.resolve(execResult(""));
  };

  return {
    adb,
    userId,
    state: (permission, id = userId) => users.get(id)?.get(permission),
    commands: () => log,
    failOn: (match, nth) => {
      scheduled.push({ match, skip: nth - 1 });
    },
    ignoreNextRevoke: () => {
      ignoreRevoke = true;
    },
    uninstall: () => {
      installed = false;
    },
  };
}

const target = (permission: string) => ({ package: APP, permission });
const pmCalls = (device: PermissionDevice) =>
  device.commands().filter((command) => command.startsWith("shell pm "));

describe("faults.revokePermission (#14069)", () => {
  test("revokes the permission, reads it back, and reset re-grants it", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const outcome = await injector.apply("apply", undefined, target(CAMERA));
    expect(outcome.status).toBe("applied");
    expect(outcome.detail).toContain("restarts");
    expect(device.state(CAMERA)).toBe("denied");
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(device.state(CAMERA)).toBe("granted");
    expect(await injector.isClean()).toBe(true);
  });

  test("acts on the app's own Android user, not user 0", async () => {
    const device = permissionDevice({
      userId: 10,
      runtime: { [CAMERA]: "granted" },
      otherUsers: { 0: { [CAMERA]: "denied" } },
    });
    const injector = createPermissionFaultInjector(device.adb, () => Promise.resolve(10));
    const outcome = await injector.apply("apply", undefined, target(CAMERA));
    expect(outcome.status).toBe("applied");
    expect(device.state(CAMERA, 10)).toBe("denied");
    expect(device.state(CAMERA, 0)).toBe("denied");
    expect(pmCalls(device)).toEqual([`shell pm revoke --user 10 ${APP} ${CAMERA}`]);
    await outcome.reset?.();
    expect(device.state(CAMERA, 10)).toBe("granted");
    expect(device.state(CAMERA, 0)).toBe("denied");
  });

  test("the same permission revoked for two users is re-granted for both", async () => {
    const device = permissionDevice({
      runtime: { [CAMERA]: "granted" },
      otherUsers: { 10: { [CAMERA]: "granted" } },
    });
    let user = 0;
    const injector = createPermissionFaultInjector(device.adb, () => Promise.resolve(user));
    await injector.apply("apply", undefined, target(CAMERA));
    user = 10;
    const second = await injector.apply("apply", undefined, target(CAMERA));
    expect(device.state(CAMERA, 0)).toBe("denied");
    expect(device.state(CAMERA, 10)).toBe("denied");
    await second.reset?.();
    expect(device.state(CAMERA, 0)).toBe("granted");
    expect(device.state(CAMERA, 10)).toBe("granted");
  });

  test("asks the resolver for the app's user on every apply", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const asked: string[] = [];
    const injector = createPermissionFaultInjector(device.adb, (packageName) => {
      asked.push(packageName);
      return Promise.resolve(0);
    });
    await injector.apply("apply", undefined, target(CAMERA));
    expect(asked).toEqual([APP]);
  });

  test("a bare platform constant is normalized to the full permission name", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    await injector.apply("apply", undefined, target("CAMERA"));
    expect(device.state(CAMERA)).toBe("denied");
    expect(pmCalls(device)).toEqual([`shell pm revoke --user 0 ${APP} ${CAMERA}`]);
  });

  test("a permission already revoked is left alone and never re-granted", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "denied" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const outcome = await injector.apply("apply", undefined, target(CAMERA));
    expect(outcome.status).toBe("unchanged");
    expect(outcome.reset).toBeUndefined();
    expect(pmCalls(device)).toEqual([]);
  });

  test("refuses an uninstalled app, an unrequested permission and an install-time permission", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    await expect(injector.apply("apply", undefined, target(MIC))).rejects.toThrow(
      /does not request/,
    );
    await expect(injector.apply("apply", undefined, target(INTERNET))).rejects.toThrow(
      /not a runtime permission/,
    );
    device.uninstall();
    await expect(injector.apply("apply", undefined, target(CAMERA))).rejects.toThrow(
      /is not installed/,
    );
    expect(pmCalls(device)).toEqual([]);
  });

  test("rejects a request without an app and permission", async () => {
    const injector = createPermissionFaultInjector(permissionDevice({ runtime: {} }).adb, () =>
      Promise.resolve(0),
    );
    await expect(injector.apply("apply", undefined, { package: APP })).rejects.toThrow(/Invalid/);
    await expect(injector.apply("apply", undefined, undefined)).rejects.toThrow(/Invalid/);
    await expect(injector.apply("on", undefined, target(CAMERA))).rejects.toThrow(/Invalid/);
  });

  test("a revoke that does not take effect is unsupported and rolled back", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    device.ignoreNextRevoke();
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    await expect(injector.apply("apply", undefined, target(CAMERA))).rejects.toThrow(
      /did not revoke/,
    );
    expect(pmCalls(device)).toEqual([
      `shell pm revoke --user 0 ${APP} ${CAMERA}`,
      `shell pm grant --user 0 ${APP} ${CAMERA}`,
    ]);
    expect(await injector.isClean()).toBe(true);
  });

  test("a failed revoke whose rollback also fails hands the reset to the controller", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    // The revoke takes effect, the read-back after it fails, and so does the rollback's grant.
    device.failOn("dumpsys package", 2);
    device.failOn("pm grant", 1);
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const failure = await injector.apply("apply", undefined, target(CAMERA)).catch((e) => e);
    expect(failure).toBeInstanceOf(OwedResetError);
    expect(device.state(CAMERA)).toBe("denied");
    await (failure as OwedResetError).owedReset();
    expect(device.state(CAMERA)).toBe("granted");
  });

  test("two revoked permissions are re-granted newest first and a failure stays owed", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted", [MIC]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    await injector.apply("apply", undefined, target(CAMERA));
    const second = await injector.apply("apply", undefined, target(MIC));
    device.failOn(`pm grant --user 0 ${APP} ${MIC}`, 1);
    await expect(second.reset?.()).rejects.toThrow(/Could not re-grant/);
    expect(device.state(CAMERA)).toBe("granted");
    expect(device.state(MIC)).toBe("denied");
    expect(pmCalls(device).filter((c) => c.includes(" grant "))).toEqual([
      `shell pm grant --user 0 ${APP} ${MIC}`,
      `shell pm grant --user 0 ${APP} ${CAMERA}`,
    ]);
    expect(await injector.isClean()).toBe(false);
    await second.reset?.();
    expect(device.state(MIC)).toBe("granted");
    expect(await injector.isClean()).toBe(true);
  });

  test("re-applying a pair it already revoked re-asserts it and keeps the reset", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    await injector.apply("apply", undefined, target(CAMERA));
    const again = await injector.apply("apply", undefined, target(CAMERA));
    expect(again.status).toBe("unchanged");
    expect(again.reset).toBeDefined();
    expect(pmCalls(device)).toEqual([`shell pm revoke --user 0 ${APP} ${CAMERA}`]);
    await again.reset?.();
    expect(device.state(CAMERA)).toBe("granted");
  });

  test("a second reset after a clean one issues no further commands", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const outcome = await injector.apply("apply", undefined, target(CAMERA));
    await outcome.reset?.();
    const before = device.commands().length;
    await outcome.reset?.();
    expect(device.commands().length).toBe(before);
  });

  test("reset after the app was uninstalled has nothing to restore", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const outcome = await injector.apply("apply", undefined, target(CAMERA));
    device.uninstall();
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
    expect(pmCalls(device)).toEqual([`shell pm revoke --user 0 ${APP} ${CAMERA}`]);
  });

  test("a reset that did not re-grant throws and stays owed", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const outcome = await injector.apply("apply", undefined, target(CAMERA));
    device.failOn("pm grant", 1);
    await expect(outcome.reset?.()).rejects.toThrow(/Could not re-grant/);
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(device.state(CAMERA)).toBe("granted");
  });
});

describe("faults.revokePermission through the controller", () => {
  test("an object request reaches the injector and unset re-grants", async () => {
    const device = permissionDevice({ runtime: { [CAMERA]: "granted" } });
    const injector = createPermissionFaultInjector(device.adb, () =>
      Promise.resolve(device.userId),
    );
    const controller = new DeviceConditionController((key) =>
      key === "faults.revokePermission" ? injector : undefined,
    );
    const applied = await controller.apply({ faults: { revokePermission: target(CAMERA) } });
    expect(applied.success).toBe(true);
    expect(applied.active).toEqual(["faults.revokePermission"]);
    expect(device.state(CAMERA)).toBe("denied");

    const cleared = await controller.apply({ faults: { revokePermission: "unset" } });
    expect(cleared.changes[0]?.status).toBe("cleared");
    expect(cleared.active).toEqual([]);
    expect(device.state(CAMERA)).toBe("granted");
  });
});

describe("object-valued faults in the request (#14069)", () => {
  test("an object fault becomes an apply change carrying its fields as params", () => {
    expect(
      deviceConditionChanges({
        faults: { revokePermission: target(CAMERA), storage: "low", dontKeepActivities: "unset" },
      }),
    ).toEqual([
      { key: "faults.dontKeepActivities", value: "unset" },
      {
        key: "faults.revokePermission",
        value: "apply",
        params: { package: APP, permission: CAMERA },
      },
      { key: "faults.storage", value: "low" },
    ]);
  });

  test("the schema accepts the object and unset, and rejects a malformed or extra field", () => {
    const parse = (revokePermission: unknown) =>
      deviceConditionInputSchema.safeParse({ faults: { revokePermission } }).success;
    expect(parse(target("CAMERA"))).toBe(true);
    expect(parse("unset")).toBe(true);
    expect(parse("on")).toBe(false);
    expect(parse({ package: "notapackage", permission: CAMERA })).toBe(false);
    expect(parse({ package: APP, permission: "a b; rm -rf /" })).toBe(false);
    expect(parse({ package: APP, permission: CAMERA, user: 10 })).toBe(false);
    expect(parse({ package: APP })).toBe(false);
  });
});

describe("resolvePermissionFaultInjector", () => {
  const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

  test("caches one injector per Android device and ignores other keys and platforms", () => {
    const adb = permissionDevice({ runtime: {} }).adb;
    const cache = new Map();
    const deps = { adbFactory: { create: () => adb }, cache };
    const first = resolvePermissionFaultInjector(android, "faults.revokePermission", deps);
    expect(first).toBeDefined();
    expect(resolvePermissionFaultInjector(android, "faults.revokePermission", deps)).toBe(first);
    expect(resolvePermissionFaultInjector(android, "faults.storage", deps)).toBeUndefined();
    expect(
      resolvePermissionFaultInjector(
        { name: "iPhone", platform: "ios", deviceId: "SIM" },
        "faults.revokePermission",
        deps,
      ),
    ).toBeUndefined();
  });
});
