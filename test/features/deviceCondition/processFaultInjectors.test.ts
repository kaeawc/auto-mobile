import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import {
  TRIM_MEMORY_LEVELS,
  createKillAppInjector,
  createTrimMemoryInjector,
  resolveProcessFaultInjector,
} from "../../../src/features/deviceCondition/processFaultInjectors";
import { deviceConditionInputSchema } from "../../../src/features/deviceCondition/DeviceConditionTypes";

const APP = "com.example.app";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

interface ProcessDevice {
  adb: FakeAdbExecutor;
  /** Whether any process of the app is alive for this user (the default is user 0). */
  running(userId?: number): boolean;
  /** Commands that changed or signalled the app (everything but the process-table reads). */
  writes(): string[];
}

interface FakeProcess {
  name: string;
  userId: number;
}

interface ProcessDeviceOptions {
  /** The app's processes at the start. */
  processes: FakeProcess[];
  /** `am kill` leaves a foreground app alone, like the real command. */
  foreground?: boolean;
  /** `am force-stop` reports success but the processes survive. */
  survivesForceStop?: boolean;
  /** What `am send-trim-memory` prints on stdout. */
  trimOutput?: string;
  /** What `am send-trim-memory` prints on stderr. */
  trimStderr?: string;
}

const main = (userId = 0): FakeProcess => ({ name: APP, userId });

/** `dumpsys activity processes` lines for the live processes, in the format the helper parses. */
const processTable = (processes: FakeProcess[]): string =>
  processes
    .map(
      (process, index) =>
        `*APP* UID u${process.userId}a123 ProcessRecord{abc${index} ${4000 + index}:${process.name}/u${process.userId}a123}`,
    )
    .join("\n");

/** A device whose process table, `am kill`, `am force-stop` and `am send-trim-memory` agree. */
function processDevice(options: ProcessDeviceOptions): ProcessDevice {
  const adb = new FakeAdbExecutor();
  const writes: string[] = [];
  let processes = [...options.processes];
  const removeUser = (userId: number) => {
    processes = processes.filter((process) => process.userId !== userId);
  };
  adb.execute = (args) => {
    const command = args.join(" ");
    if (command === "shell dumpsys activity processes") {
      return Promise.resolve(execResult(processTable(processes)));
    }
    writes.push(command);
    const target = /--user (\d+)/.exec(command);
    const userId = target === null ? 0 : Number(target[1]);
    if (command.startsWith("shell am kill ") && options.foreground !== true) {
      removeUser(userId);
    } else if (command.startsWith("shell am force-stop ") && options.survivesForceStop !== true) {
      removeUser(userId);
    }
    if (command.startsWith("shell am send-trim-memory ")) {
      return Promise.resolve({
        ...execResult(options.trimOutput ?? ""),
        stderr: options.trimStderr ?? "",
      });
    }
    return Promise.resolve(execResult(""));
  };
  adb.executeCommand = (command) => adb.execute(command.split(" "));
  return {
    adb,
    running: (userId = 0) => processes.some((process) => process.userId === userId),
    writes: () => writes,
  };
}

const resolveUser =
  (userId = 0) =>
  () =>
    Promise.resolve(userId);
const killTarget = (mode: string) => ({ package: APP, mode });
const trimTarget = (level: string) => ({ package: APP, level });

describe("faults.killApp (#14068)", () => {
  test("forceStop ends the process, registers no reset, and is always clean", async () => {
    const device = processDevice({ processes: [main()] });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("forceStop"));
    expect(outcome.status).toBe("applied");
    expect(outcome.reset).toBeUndefined();
    expect(outcome.detail).toContain("stays stopped");
    expect(device.running()).toBe(false);
    expect(device.writes()).toEqual([`shell am force-stop --user 0 ${APP}`]);
    expect(await injector.isClean()).toBe(true);
  });

  test("background kills a process the system could reclaim", async () => {
    const device = processDevice({ processes: [main()] });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("background"));
    expect(outcome.status).toBe("applied");
    expect(device.writes()).toEqual([`shell am kill --user 0 ${APP}`]);
  });

  test("background leaves the foreground app running and says how to end it", async () => {
    const device = processDevice({ processes: [main()], foreground: true });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("background"));
    expect(outcome.status).toBe("unchanged");
    expect(outcome.detail).toContain("forceStop");
    expect(device.running()).toBe(true);
  });

  test("an app that is not running is left alone with no command sent", async () => {
    const device = processDevice({ processes: [] });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("forceStop"));
    expect(outcome.status).toBe("unchanged");
    expect(device.writes()).toEqual([]);
  });

  test("a force-stop that did not end the process is unsupported", async () => {
    const device = processDevice({ processes: [main()], survivesForceStop: true });
    const injector = createKillAppInjector(device.adb, resolveUser());
    await expect(injector.apply("apply", undefined, killTarget("forceStop"))).rejects.toThrow(
      /still running after am force-stop/,
    );
  });

  test("acts on the app's own Android user and leaves another user's copy running", async () => {
    const device = processDevice({ processes: [main(0), main(10)] });
    const injector = createKillAppInjector(device.adb, resolveUser(10));
    const outcome = await injector.apply("apply", undefined, killTarget("forceStop"));
    expect(outcome.status).toBe("applied");
    expect(device.writes()).toEqual([`shell am force-stop --user 10 ${APP}`]);
    expect(device.running(10)).toBe(false);
    expect(device.running(0)).toBe(true);
  });

  test("a package-owned secondary process counts as the app running", async () => {
    const device = processDevice({ processes: [{ name: `${APP}:worker`, userId: 0 }] });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("forceStop"));
    expect(outcome.status).toBe("applied");
    expect(device.writes()).toEqual([`shell am force-stop --user 0 ${APP}`]);
    expect(device.running()).toBe(false);
  });

  test("an app running only for another user is not running for this one", async () => {
    const device = processDevice({ processes: [main(0)] });
    const injector = createKillAppInjector(device.adb, resolveUser(10));
    const outcome = await injector.apply("apply", undefined, killTarget("forceStop"));
    expect(outcome.status).toBe("unchanged");
    expect(device.writes()).toEqual([]);
  });

  test("rejects a malformed request before touching the device", async () => {
    const device = processDevice({ processes: [main()] });
    const injector = createKillAppInjector(device.adb, resolveUser());
    for (const params of [
      undefined,
      { package: APP },
      killTarget("terminate"),
      { ...killTarget("forceStop"), user: 10 },
      { package: "a b; rm -rf /", mode: "forceStop" },
    ]) {
      await expect(injector.apply("apply", undefined, params)).rejects.toThrow(/Invalid/);
    }
    await expect(injector.apply("on", undefined, killTarget("forceStop"))).rejects.toThrow(
      /Invalid/,
    );
    expect(device.writes()).toEqual([]);
  });

  test("through the controller it reports applied, owes no reset, and unset is a no-op", async () => {
    const device = processDevice({ processes: [main()] });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const controller = new DeviceConditionController((key) =>
      key === "faults.killApp" ? injector : undefined,
    );
    const applied = await controller.apply({
      faults: { killApp: killTarget("forceStop") as never },
    });
    expect(applied.changes[0]?.status).toBe("applied");
    expect(applied.active).toEqual([]);
    const unset = await controller.apply({ faults: { killApp: "unset" } });
    expect(unset.changes[0]?.status).toBe("unchanged");
    expect(device.writes()).toEqual([`shell am force-stop --user 0 ${APP}`]);
  });
});

describe("faults.trimMemory (#14068)", () => {
  test("sends the level to the running app and owes no reset", async () => {
    const device = processDevice({ processes: [main()] });
    const injector = createTrimMemoryInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, trimTarget("RUNNING_CRITICAL"));
    expect(outcome.status).toBe("applied");
    expect(outcome.reset).toBeUndefined();
    expect(device.writes()).toEqual([`shell am send-trim-memory --user 0 ${APP} RUNNING_CRITICAL`]);
    expect(device.running()).toBe(true);
    expect(await injector.isClean()).toBe(true);
  });

  test("every documented level is accepted", async () => {
    for (const level of TRIM_MEMORY_LEVELS) {
      const device = processDevice({ processes: [main()] });
      const injector = createTrimMemoryInjector(device.adb, resolveUser());
      await injector.apply("apply", undefined, trimTarget(level));
      expect(device.writes()).toEqual([`shell am send-trim-memory --user 0 ${APP} ${level}`]);
    }
  });

  test("an app that is not running is refused with no command sent", async () => {
    const device = processDevice({ processes: [] });
    const injector = createTrimMemoryInjector(device.adb, resolveUser());
    await expect(injector.apply("apply", undefined, trimTarget("COMPLETE"))).rejects.toThrow(
      /is not running/,
    );
    expect(device.writes()).toEqual([]);
  });

  test("a request am refuses on stdout is unsupported", async () => {
    const device = processDevice({ processes: [main()], trimOutput: "Error: Unknown process" });
    const injector = createTrimMemoryInjector(device.adb, resolveUser());
    await expect(injector.apply("apply", undefined, trimTarget("COMPLETE"))).rejects.toThrow(
      /send-trim-memory.*failed/,
    );
  });

  test("a refusal am prints only on stderr is unsupported too", async () => {
    const device = processDevice({ processes: [main()], trimStderr: "Error: Unknown process" });
    const injector = createTrimMemoryInjector(device.adb, resolveUser());
    await expect(injector.apply("apply", undefined, trimTarget("COMPLETE"))).rejects.toThrow(
      /send-trim-memory.*failed.*Unknown process/,
    );
  });

  test("acts on the app's own Android user", async () => {
    const device = processDevice({ processes: [main(10)] });
    const injector = createTrimMemoryInjector(device.adb, resolveUser(10));
    await injector.apply("apply", undefined, trimTarget("MODERATE"));
    expect(device.writes()).toEqual([`shell am send-trim-memory --user 10 ${APP} MODERATE`]);
  });

  test("rejects an unknown level or a malformed request", async () => {
    const device = processDevice({ processes: [main()] });
    const injector = createTrimMemoryInjector(device.adb, resolveUser());
    for (const params of [undefined, { package: APP }, trimTarget("LOW"), trimTarget("complete")]) {
      await expect(injector.apply("apply", undefined, params)).rejects.toThrow(/Invalid/);
    }
    expect(device.writes()).toEqual([]);
  });
});

describe("process faults in the request and resolver", () => {
  test("the schema accepts the objects and unset and rejects anything else", () => {
    const parse = (faults: unknown) => deviceConditionInputSchema.safeParse({ faults }).success;
    expect(parse({ killApp: killTarget("background"), trimMemory: trimTarget("HIDDEN") })).toBe(
      true,
    );
    expect(parse({ killApp: "unset", trimMemory: "unset" })).toBe(true);
    expect(parse({ killApp: "on" })).toBe(false);
    expect(parse({ killApp: { package: APP } })).toBe(false);
    expect(parse({ killApp: killTarget("kill") })).toBe(false);
    expect(parse({ trimMemory: trimTarget("LOW") })).toBe(false);
    expect(parse({ trimMemory: { ...trimTarget("HIDDEN"), user: 1 } })).toBe(false);
  });

  test("resolves each key on Android and ignores other keys and platforms", () => {
    const adb = processDevice({ processes: [] }).adb;
    const deps = { adbFactory: { create: () => adb } };
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    expect(resolveProcessFaultInjector(android, "faults.killApp", deps)?.key).toBe(
      "faults.killApp",
    );
    expect(resolveProcessFaultInjector(android, "faults.trimMemory", deps)?.key).toBe(
      "faults.trimMemory",
    );
    expect(resolveProcessFaultInjector(android, "faults.storage", deps)).toBeUndefined();
    expect(
      resolveProcessFaultInjector(
        { name: "iPhone", platform: "ios", deviceId: "SIM" },
        "faults.killApp",
        deps,
      ),
    ).toBeUndefined();
  });
});
