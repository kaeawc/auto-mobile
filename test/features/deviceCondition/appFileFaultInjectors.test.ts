import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  createCorruptAppFileInjector,
  resolveAppFileFaultInjector,
} from "../../../src/features/deviceCondition/appFileFaultInjectors";
import {
  APP_FILE_PATH_PATTERN,
  deviceConditionInputSchema,
} from "../../../src/features/deviceCondition/DeviceConditionTypes";

const APP = "com.example.app";
const DB = "databases/app.db";
const PREFS = "shared_prefs/settings.xml";
const BACKUP = `${DB}.automobile-backup`;

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

const md5 = (content: string): string => createHash("md5").update(content, "latin1").digest("hex");

interface AppDevice {
  adb: FakeAdbExecutor;
  /** The app's files by relative path. */
  files: Map<string, string>;
  commands(): string[];
  /** Reject a later command containing `match`: the `nth` one from now (1 = the next). */
  failOn(match: string, nth: number): void;
  /** Make the next `cp` succeed without copying anything. */
  ignoreNextCopy(): void;
  /** The next `cp` writes half the file to its destination, then fails (the storage filled up). */
  interruptNextCopy(): void;
  /** The next `cp` writes half the file to its destination and reports success. */
  shortNextCopy(): void;
  /** Run `change` as the app is force-stopped: it flushes its last write on the way down. */
  onForceStop(change: (files: Map<string, string>) => void): void;
}

interface AppDeviceOptions {
  files: Record<string, string>;
  /** `run-as` is refused, as for a release build. */
  debuggable?: boolean;
}

/** A device whose `run-as` shell agrees about one app's data directory. */
function appDevice(options: AppDeviceOptions): AppDevice {
  const adb = new FakeAdbExecutor();
  const log: string[] = [];
  const files = new Map(Object.entries(options.files));
  let ignoreCopy = false;
  let copyFault: "interrupt" | "short" | undefined;
  let forceStopHook: ((files: Map<string, string>) => void) | undefined;
  const scheduled: { match: string; skip: number }[] = [];

  const runAs = (args: string[]): string => {
    const [command, ...rest] = args;
    const path = rest[rest.length - 1] ?? "";
    switch (command) {
      case "ls":
        return files.has(rest[1] ?? "") ? (rest[1] ?? "") : "";
      case "md5sum":
        return `${md5(files.get(rest[0] ?? "") ?? "")}  ${rest[0]}`;
      case "stat":
        return String((files.get(path) ?? "").length);
      case "cp": {
        const source = files.get(rest[0] ?? "") ?? "";
        if (ignoreCopy) {
          ignoreCopy = false;
        } else if (copyFault !== undefined) {
          const fault = copyFault;
          copyFault = undefined;
          files.set(rest[1] ?? "", source.slice(0, Math.floor(source.length / 2)));
          if (fault === "interrupt") {
            throw new Error("cp: write error: No space left on device");
          }
        } else {
          files.set(rest[1] ?? "", source);
        }
        return "";
      }
      case "dd": {
        const target = (rest.find((a) => a.startsWith("of=")) ?? "").slice(3);
        const content = files.get(target) ?? "";
        files.set(target, "\0".repeat(256) + content.slice(256));
        return "";
      }
      case "truncate":
        files.set(path, (files.get(path) ?? "").slice(0, Number(rest[1])));
        return "";
      case "rm":
        files.delete(path);
        return "";
      default:
        return "";
    }
  };

  adb.execute = (args) => {
    const command = args.join(" ");
    log.push(command);
    if (command.startsWith("shell am force-stop ")) {
      forceStopHook?.(files);
    }
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
    const match = /^shell run-as (\S+) --user (\d+) (.*)$/.exec(command);
    if (match === null) {
      return Promise.resolve(execResult(""));
    }
    if (options.debuggable === false) {
      // On a device the trailing `2>/dev/null; true` hides run-as's refusal and exits 0.
      if (match[3].endsWith("2>/dev/null; true")) {
        return Promise.resolve(execResult(""));
      }
      return Promise.reject(new Error(`run-as: package not debuggable: ${match[1]}`));
    }
    const tokens = match[3]
      .split(" ")
      .filter((token) => token !== "2>/dev/null;" && token !== "true");
    return Promise.resolve(execResult(runAs(tokens)));
  };

  return {
    adb,
    files,
    commands: () => log,
    failOn: (match, nth) => {
      scheduled.push({ match, skip: nth - 1 });
    },
    ignoreNextCopy: () => {
      ignoreCopy = true;
    },
    interruptNextCopy: () => {
      copyFault = "interrupt";
    },
    shortNextCopy: () => {
      copyFault = "short";
    },
    onForceStop: (change) => {
      forceStopHook = change;
    },
  };
}

const SQLITE = `SQLite format 3\0${"x".repeat(600)}`;
const target = (path: string, mode: string) => ({ package: APP, path, mode });
const userOf =
  (userId = 0) =>
  () =>
    Promise.resolve(userId);
const writes = (device: AppDevice) =>
  device.commands().filter((c) => / (cp|dd|truncate|rm) |force-stop/.test(c));

describe("faults.corruptAppFile (#14066)", () => {
  test("overwrite zeroes the header, force-stops first, and reset restores and verifies it", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    const outcome = await injector.apply("apply", undefined, target(DB, "overwrite"));
    expect(outcome.status).toBe("applied");
    expect(outcome.detail).toContain("force-stopped");
    expect(device.files.get(DB)?.startsWith("\0".repeat(256))).toBe(true);
    expect(device.files.get(BACKUP)).toBe(SQLITE);
    expect(writes(device)[0]).toBe(`shell am force-stop --user 0 ${APP}`);
    expect(await injector.isClean()).toBe(false);

    await outcome.reset?.();
    expect(device.files.get(DB)).toBe(SQLITE);
    expect(device.files.has(BACKUP)).toBe(false);
    expect(await injector.isClean()).toBe(true);
  });

  test("truncate cuts the file in half and reset restores it", async () => {
    const original = "<map>".padEnd(400, "a");
    const device = appDevice({ files: { [PREFS]: original } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    const outcome = await injector.apply("apply", undefined, target(PREFS, "truncate"));
    expect(device.files.get(PREFS)?.length).toBe(200);
    await outcome.reset?.();
    expect(device.files.get(PREFS)).toBe(original);
    expect(device.files.has(`${PREFS}.automobile-backup`)).toBe(false);
  });

  test("a release build is refused with the reason and nothing is written", async () => {
    const device = appDevice({ files: { [DB]: SQLITE }, debuggable: false });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await expect(injector.apply("apply", undefined, target(DB, "overwrite"))).rejects.toThrow(
      /debuggable/,
    );
    expect(writes(device)).toEqual([]);
  });

  test("a missing file is refused", async () => {
    const device = appDevice({ files: {} });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await expect(injector.apply("apply", undefined, target(DB, "overwrite"))).rejects.toThrow(
      /does not exist/,
    );
    expect(writes(device)).toEqual([]);
  });

  test("a backup left by an earlier session is never overwritten", async () => {
    const device = appDevice({ files: { [DB]: "damaged", [BACKUP]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await expect(injector.apply("apply", undefined, target(DB, "overwrite"))).rejects.toThrow(
      /earlier session/,
    );
    expect(device.files.get(BACKUP)).toBe(SQLITE);
    expect(writes(device)).toEqual([]);
  });

  test("damage that changes nothing is unsupported and rolled back", async () => {
    const device = appDevice({ files: { [DB]: "\0".repeat(300) } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await expect(injector.apply("apply", undefined, target(DB, "overwrite"))).rejects.toThrow(
      /did not change/,
    );
    expect(device.files.has(BACKUP)).toBe(false);
    expect(await injector.isClean()).toBe(true);
  });

  test("a failed apply whose rollback also fails hands the reset to the controller", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    // The damage takes effect, the read-back after it fails, and so does the rollback's copy. The
    // third checksum is that read-back (after the original's and the backup's).
    device.failOn("md5sum", 3);
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    device.failOn("cp databases/app.db.automobile-backup", 1);
    const failure = await injector
      .apply("apply", undefined, target(DB, "overwrite"))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(OwedResetError);
    expect(device.files.get(DB)).not.toBe(SQLITE);
    await (failure as OwedResetError).owedReset();
    expect(device.files.get(DB)).toBe(SQLITE);
    expect(device.files.has(BACKUP)).toBe(false);
  });

  test("an interrupted backup never overwrites the intact original", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    device.interruptNextCopy();
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await expect(injector.apply("apply", undefined, target(DB, "overwrite"))).rejects.toThrow(
      /No space left/,
    );
    expect(device.files.get(DB)).toBe(SQLITE);
    expect(device.files.has(BACKUP)).toBe(false);
    expect(await injector.isClean()).toBe(true);
  });

  test("a short backup that reports success is caught before the file is touched", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    device.shortNextCopy();
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await expect(injector.apply("apply", undefined, target(DB, "overwrite"))).rejects.toThrow(
      /backup of .* does not match/,
    );
    expect(device.files.get(DB)).toBe(SQLITE);
    expect(device.files.has(BACKUP)).toBe(false);
    expect(device.commands().some((c) => c.includes(" dd "))).toBe(false);
  });

  test("a write the app flushes as it is stopped is part of the original that reset restores", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const flushed = `${SQLITE}-flushed`;
    device.onForceStop((files) => files.set(DB, flushed));
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    const outcome = await injector.apply("apply", undefined, target(DB, "overwrite"));
    await outcome.reset?.();
    expect(device.files.get(DB)).toBe(flushed);
    expect(device.files.has(BACKUP)).toBe(false);
    expect(await injector.isClean()).toBe(true);
  });

  test("a restore that does not reproduce the original throws and stays owed", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    const outcome = await injector.apply("apply", undefined, target(DB, "overwrite"));
    device.ignoreNextCopy();
    await expect(outcome.reset?.()).rejects.toThrow(/does not match its original/);
    expect(device.files.has(BACKUP)).toBe(true);
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(device.files.get(DB)).toBe(SQLITE);
    expect(device.files.has(BACKUP)).toBe(false);
  });

  test("two files are restored newest first and a failure keeps its file owed", async () => {
    const device = appDevice({ files: { [DB]: SQLITE, [PREFS]: "<map/>".padEnd(300, " ") } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await injector.apply("apply", undefined, target(DB, "overwrite"));
    const second = await injector.apply("apply", undefined, target(PREFS, "truncate"));
    device.failOn(`cp ${PREFS}.automobile-backup`, 1);
    await expect(second.reset?.()).rejects.toThrow(/Could not restore/);
    expect(device.files.get(DB)).toBe(SQLITE);
    expect(device.files.get(PREFS)?.length).toBe(150);
    const restoreOrder = device
      .commands()
      .filter((c) => c.includes(" cp ") && c.includes(".automobile-backup "));
    expect(restoreOrder[0]).toContain(PREFS);
    await second.reset?.();
    expect(device.files.get(PREFS)?.length).toBe(300);
  });

  test("re-applying a file it already damaged keeps the reset and does not copy again", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    await injector.apply("apply", undefined, target(DB, "overwrite"));
    const again = await injector.apply("apply", undefined, target(DB, "overwrite"));
    expect(again.status).toBe("unchanged");
    expect(again.reset).toBeDefined();
    expect(device.commands().filter((c) => c.includes(" cp "))).toHaveLength(1);
    await again.reset?.();
    expect(device.files.get(DB)).toBe(SQLITE);
  });

  test("a second reset after a clean one issues no further commands", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    const outcome = await injector.apply("apply", undefined, target(DB, "overwrite"));
    await outcome.reset?.();
    const before = device.commands().length;
    await outcome.reset?.();
    expect(device.commands().length).toBe(before);
  });

  test("acts through the app's own Android user", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf(10));
    await injector.apply("apply", undefined, target(DB, "overwrite"));
    expect(device.commands().every((c) => !c.includes("run-as") || c.includes("--user 10"))).toBe(
      true,
    );
    expect(writes(device)[0]).toBe(`shell am force-stop --user 10 ${APP}`);
  });

  test("rejects a malformed request or a path that escapes the data directory", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    for (const params of [
      undefined,
      { package: APP, path: DB },
      target(DB, "shred"),
      target("../other/app.db", "overwrite"),
      target("/data/data/other/app.db", "overwrite"),
      target("databases/a b; rm -rf /", "overwrite"),
      { ...target(DB, "overwrite"), user: 10 },
    ]) {
      await expect(injector.apply("apply", undefined, params)).rejects.toThrow(/Invalid/);
    }
    await expect(injector.apply("on", undefined, target(DB, "overwrite"))).rejects.toThrow(
      /Invalid/,
    );
    expect(device.commands()).toEqual([]);
  });

  test("through the controller, unset restores the file", async () => {
    const device = appDevice({ files: { [DB]: SQLITE } });
    const injector = createCorruptAppFileInjector(device.adb, userOf());
    const controller = new DeviceConditionController((key) =>
      key === "faults.corruptAppFile" ? injector : undefined,
    );
    const applied = await controller.apply({
      faults: { corruptAppFile: { package: APP, path: DB, mode: "overwrite" } },
    });
    expect(applied.active).toEqual(["faults.corruptAppFile"]);
    const cleared = await controller.apply({ faults: { corruptAppFile: "unset" } });
    expect(cleared.changes[0]?.status).toBe("cleared");
    expect(cleared.active).toEqual([]);
    expect(device.files.get(DB)).toBe(SQLITE);
  });
});

describe("corruptAppFile in the request and resolver", () => {
  test("the path pattern accepts names under the data directory and nothing that escapes it", () => {
    for (const ok of [DB, PREFS, "files/.hidden", "a/b.c", "databases/app.db-wal"]) {
      expect(APP_FILE_PATH_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of [
      "..",
      ".",
      "a/..",
      "a/.",
      "../x",
      "a/../b",
      "a//b",
      "/abs",
      "a b",
      "a;b",
      "",
    ]) {
      expect(APP_FILE_PATH_PATTERN.test(bad)).toBe(false);
    }
  });

  test("the schema accepts the object and unset and rejects anything else", () => {
    const parse = (corruptAppFile: unknown) =>
      deviceConditionInputSchema.safeParse({ faults: { corruptAppFile } }).success;
    expect(parse({ package: APP, path: DB, mode: "truncate" })).toBe(true);
    expect(parse("unset")).toBe(true);
    expect(parse("on")).toBe(false);
    expect(parse({ package: APP, path: "../x", mode: "truncate" })).toBe(false);
    expect(parse({ package: APP, path: DB, mode: "shred" })).toBe(false);
    expect(parse({ package: APP, path: DB })).toBe(false);
  });

  test("caches one injector per Android device and ignores other keys and platforms", () => {
    const adb = appDevice({ files: {} }).adb;
    const cache = new Map();
    const deps = { adbFactory: { create: () => adb }, cache };
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const first = resolveAppFileFaultInjector(android, "faults.corruptAppFile", deps);
    expect(first).toBeDefined();
    expect(resolveAppFileFaultInjector(android, "faults.corruptAppFile", deps)).toBe(first);
    expect(resolveAppFileFaultInjector(android, "faults.storage", deps)).toBeUndefined();
    expect(
      resolveAppFileFaultInjector(
        { name: "iPhone", platform: "ios", deviceId: "SIM" },
        "faults.corruptAppFile",
        deps,
      ),
    ).toBeUndefined();
  });
});
