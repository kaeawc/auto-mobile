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
  running(): boolean;
  /** Commands that changed or signalled the app (everything but the `pidof` probes). */
  writes(): string[];
}

interface ProcessDeviceOptions {
  running: boolean;
  /** `am kill` leaves a foreground app alone, like the real command. */
  foreground?: boolean;
  /** `am force-stop` reports success but the process survives. */
  survivesForceStop?: boolean;
  /** What `am send-trim-memory` prints. */
  trimOutput?: string;
}

/** A device whose `pidof`, `am kill`, `am force-stop` and `am send-trim-memory` agree about one process. */
function processDevice(options: ProcessDeviceOptions): ProcessDevice {
  const adb = new FakeAdbExecutor();
  const writes: string[] = [];
  let running = options.running;
  adb.execute = (args) => {
    const command = args.join(" ");
    if (command.startsWith("shell pidof ")) {
      return Promise.resolve(execResult(running ? "4242" : ""));
    }
    writes.push(command);
    if (command.startsWith("shell am kill ") && options.foreground !== true) {
      running = false;
    } else if (command.startsWith("shell am force-stop ") && options.survivesForceStop !== true) {
      running = false;
    }
    return Promise.resolve(
      execResult(
        command.startsWith("shell am send-trim-memory ") ? (options.trimOutput ?? "") : "",
      ),
    );
  };
  return { adb, running: () => running, writes: () => writes };
}

const resolveUser =
  (userId = 0) =>
  () =>
    Promise.resolve(userId);
const killTarget = (mode: string) => ({ package: APP, mode });
const trimTarget = (level: string) => ({ package: APP, level });

describe("faults.killApp (#14068)", () => {
  test("forceStop ends the process, registers no reset, and is always clean", async () => {
    const device = processDevice({ running: true });
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
    const device = processDevice({ running: true });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("background"));
    expect(outcome.status).toBe("applied");
    expect(device.writes()).toEqual([`shell am kill --user 0 ${APP}`]);
  });

  test("background leaves the foreground app running and says how to end it", async () => {
    const device = processDevice({ running: true, foreground: true });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("background"));
    expect(outcome.status).toBe("unchanged");
    expect(outcome.detail).toContain("forceStop");
    expect(device.running()).toBe(true);
  });

  test("an app that is not running is left alone with no command sent", async () => {
    const device = processDevice({ running: false });
    const injector = createKillAppInjector(device.adb, resolveUser());
    const outcome = await injector.apply("apply", undefined, killTarget("forceStop"));
    expect(outcome.status).toBe("unchanged");
    expect(device.writes()).toEqual([]);
  });

  test("a force-stop that did not end the process is unsupported", async () => {
    const device = processDevice({ running: true, survivesForceStop: true });
    const injector = createKillAppInjector(device.adb, resolveUser());
    await expect(injector.apply("apply", undefined, killTarget("forceStop"))).rejects.toThrow(
      /still running after am force-stop/,
    );
  });

  test("acts on the app's own Android user", async () => {
    const device = processDevice({ running: true });
    const injector = createKillAppInjector(device.adb, resolveUser(10));
    await injector.apply("apply", undefined, killTarget("forceStop"));
    expect(device.writes()).toEqual([`shell am force-stop --user 10 ${APP}`]);
  });

  test("rejects a malformed request before touching the device", async () => {
    const device = processDevice({ running: true });
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
    const device = processDevice({ running: true });
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
    const device = processDevice({ running: true });
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
      const device = processDevice({ running: true });
      const injector = createTrimMemoryInjector(device.adb, resolveUser());
      await injector.apply("apply", undefined, trimTarget(level));
      expect(device.writes()).toEqual([`shell am send-trim-memory --user 0 ${APP} ${level}`]);
    }
  });

  test("an app that is not running is refused with no command sent", async () => {
    const device = processDevice({ running: false });
    const injector = createTrimMemoryInjector(device.adb, resolveUser());
    await expect(injector.apply("apply", undefined, trimTarget("COMPLETE"))).rejects.toThrow(
      /is not running/,
    );
    expect(device.writes()).toEqual([]);
  });

  test("a request am refuses on stdout is unsupported", async () => {
    const device = processDevice({ running: true, trimOutput: "Error: Unknown process" });
    const injector = createTrimMemoryInjector(device.adb, resolveUser());
    await expect(injector.apply("apply", undefined, trimTarget("COMPLETE"))).rejects.toThrow(
      /send-trim-memory.*failed/,
    );
  });

  test("acts on the app's own Android user", async () => {
    const device = processDevice({ running: true });
    const injector = createTrimMemoryInjector(device.adb, resolveUser(10));
    await injector.apply("apply", undefined, trimTarget("MODERATE"));
    expect(device.writes()).toEqual([`shell am send-trim-memory --user 10 ${APP} MODERATE`]);
  });

  test("rejects an unknown level or a malformed request", async () => {
    const device = processDevice({ running: true });
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
    const adb = processDevice({ running: false }).adb;
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
