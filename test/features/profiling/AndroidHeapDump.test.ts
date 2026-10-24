import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AndroidHeapDump,
  classifyHeapDumpEligibility,
  HeapDumpRefusedError,
} from "../../../src/features/profiling/AndroidHeapDump";
import { ProfilingRegistry } from "../../../src/features/profiling/ProfilingRegistry";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeProfilingDevice, FakeProfilingStore } from "../../fakes/FakeProfilingDevice";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const APP = "dev.jasonpearson.automobile.playground";
const fixtures = join(import.meta.dir, "../../fixtures");
const profiling = (name: string) => readFileSync(join(fixtures, "android-profiling", name), "utf8");
const dumpsysPackage = (name: string) =>
  readFileSync(join(fixtures, "android-dumpsys-package", name), "utf8");

function setup() {
  const device = new FakeProfilingDevice();
  device.packageDump = dumpsysPackage("dumpsys-package-installed.txt");
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const registry = new ProfilingRegistry();
  const store = new FakeProfilingStore(device);
  const dump = new AndroidHeapDump({
    adb: device,
    timer,
    idGenerator: new FakeIdGenerator(["h1"]),
    registry,
    store,
  });
  return { device, registry, store, dump };
}

const REMOTE = "/data/local/tmp/automobile-heap-h1.hprof";

describe("classifyHeapDumpEligibility", () => {
  test("reads the captured debuggable Playground, release flags and the guessed profileable token", () => {
    expect(classifyHeapDumpEligibility(dumpsysPackage("dumpsys-package-installed.txt"))).toBe(true);
    expect(classifyHeapDumpEligibility(profiling("dumpsys-package-release-flags.txt"))).toBe(false);
    expect(classifyHeapDumpEligibility(profiling("dumpsys-package-profileable-flags.txt"))).toBe(
      true,
    );
  });

  test("gives no verdict without a pkgFlags line", () => {
    expect(classifyHeapDumpEligibility("")).toBeUndefined();
    expect(
      classifyHeapDumpEligibility(profiling("dumpsys-package-release-flags.txt").split("\n")[0]),
    ).toBeUndefined();
  });
});

describe("AndroidHeapDump (#14113)", () => {
  test("dumps, pulls, and deletes the device copy", async () => {
    const { device, registry, dump } = setup();

    const result = await dump.dump({ appId: APP, deviceId: DEVICE, sessionId: "s-1" });

    expect(result).toMatchObject({
      path: "/host/outputs/1-heapDump-h1.hprof",
      sizeBytes: 8192,
      native: false,
      attempts: [{ command: `am dumpheap '${APP}' ${REMOTE}`, outcome: "dumped" }],
    });
    expect(device.commands.filter((c) => /dumpheap|pull|rm -f/.test(c))).toEqual([
      `shell am dumpheap '${APP}' ${REMOTE}`,
      `pull ${REMOTE} /host/outputs/1-heapDump-h1.hprof`,
      `shell rm -f ${REMOTE}`,
    ]);
    expect(device.deviceFiles.size).toBe(0);
    expect(registry.takeOwnedBy(DEVICE, "s-1").deviceFiles).toEqual([]);
  });

  test("native passes -n", async () => {
    const { device, dump } = setup();
    const result = await dump.dump({ appId: APP, deviceId: DEVICE, native: true });
    expect(result.native).toBe(true);
    expect(device.commands).toContain(`shell am dumpheap -n '${APP}' ${REMOTE}`);
  });

  test("the device path is registered to its session while the dump runs", async () => {
    const { device, registry, dump } = setup();
    let during: string[] = [];
    const original = device.execute.bind(device);
    device.execute = async (args) => {
      if (args[0] === "pull") {
        during = registry.takeOwnedBy(DEVICE, "s-1").deviceFiles.map((f) => f.remotePath);
      }
      return original(args);
    };
    await dump.dump({ appId: APP, deviceId: DEVICE, sessionId: "s-1" });
    expect(during).toEqual([REMOTE]);
  });

  test("refuses an app that is neither debuggable nor profileable before touching the heap", async () => {
    const { device, registry, dump } = setup();
    device.packageDump = profiling("dumpsys-package-release-flags.txt");

    const refusal = await dump.dump({ appId: "com.example.release", deviceId: DEVICE }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(HeapDumpRefusedError);
    expect((refusal as HeapDumpRefusedError).code).toBe("heap_dump_not_debuggable");
    expect((refusal as Error).message).toContain("heap_dump_not_debuggable: com.example.release");
    expect(device.commands.some((c) => c.includes("dumpheap"))).toBe(false);
    expect(registry.takeOwnedBy(DEVICE, "s-1")).toEqual({ traces: [], deviceFiles: [] });
  });

  test("maps am's own SecurityException to the same typed refusal and cleans up", async () => {
    const { device, store, dump } = setup();
    device.dumpheapOutput["am dumpheap"] = profiling("am-dumpheap-not-debuggable.txt");

    await expect(dump.dump({ appId: APP, deviceId: DEVICE })).rejects.toBeInstanceOf(
      HeapDumpRefusedError,
    );

    expect(device.commands).toContain(`shell rm -f ${REMOTE}`);
    expect(store.removed).toEqual(["/host/outputs/1-heapDump-h1.hprof"]);
    expect(device.commands.some((c) => c.startsWith("shell cmd activity"))).toBe(false);
  });

  test("a package that is not installed is an ordinary error", async () => {
    const { device, dump } = setup();
    device.packageDump = dumpsysPackage("dumpsys-package-not-installed.txt");
    await expect(dump.dump({ appId: APP, deviceId: DEVICE })).rejects.toThrow("is not installed");
  });

  test("a process that is not running asks for a launch", async () => {
    const { device, dump } = setup();
    device.dumpheapOutput["am dumpheap"] = profiling("am-dumpheap-unknown-process.txt");
    await expect(dump.dump({ appId: APP, deviceId: DEVICE })).rejects.toThrow(
      "is not running on emulator-5554",
    );
  });

  test("falls back to cmd activity dumpheap when am wrote nothing, reporting both attempts", async () => {
    const { device, dump } = setup();
    device.dumpheapOutput["am dumpheap"] = "";

    const result = await dump.dump({ appId: APP, deviceId: DEVICE });

    expect(
      result.attempts.map((a) => [a.command.split(" ").slice(0, 3).join(" "), a.outcome]),
    ).toEqual([
      ["am dumpheap '" + APP + "'", "empty"],
      ["cmd activity dumpheap", "dumped"],
    ]);
  });

  test("when no entry point writes a dump the error lists every attempt", async () => {
    const { device, dump } = setup();
    device.dumpheapOutput["am dumpheap"] = "";
    device.dumpheapOutput["cmd activity dumpheap"] = "";
    await expect(dump.dump({ appId: APP, deviceId: DEVICE })).rejects.toThrow(
      /No heap dump was written.*am dumpheap.*cmd activity dumpheap/,
    );
    expect(device.deviceFiles.size).toBe(0);
  });

  test("a failed pull deletes the device copy and the partial host file", async () => {
    const { device, store, dump } = setup();
    device.failing.set("pull ", "adb: pull failed");
    await expect(dump.dump({ appId: APP, deviceId: DEVICE })).rejects.toThrow("pull failed");
    expect(device.deviceFiles.size).toBe(0);
    expect(store.removed).toHaveLength(1);
  });

  test("a dump that keeps growing is reported unfinished, never pulled, and the device copy is removed (#14113 review)", async () => {
    const { device, store, registry, dump } = setup();
    let size = 0;
    const original = device.execute.bind(device);
    device.execute = async (args) => {
      if (args.join(" ").startsWith("shell wc -c")) {
        size += 1000;
        device.deviceFiles.set(REMOTE, size);
      }
      return original(args);
    };

    await expect(dump.dump({ appId: APP, deviceId: DEVICE, sessionId: "s-1" })).rejects.toThrow(
      "heap_dump_incomplete",
    );

    expect(device.commands.some((c) => c.startsWith("pull"))).toBe(false);
    expect(device.commands).toContain(`shell rm -f ${REMOTE}`);
    expect(device.commands.some((c) => c.startsWith("shell cmd activity"))).toBe(false);
    expect(store.removed).toHaveLength(1);
    expect(registry.takeOwnedBy(DEVICE, "s-1").deviceFiles).toEqual([]);
  });

  test("a request cancelled after the dump was written still removes the device file (#14113 review)", async () => {
    const { device, registry, dump } = setup();
    const controller = new AbortController();
    const original = device.execute.bind(device);
    device.execute = async (args, options) => {
      const result = await original(args, options);
      if (args.join(" ").includes("dumpheap")) {
        controller.abort();
      }
      return result;
    };

    await expect(
      runWithAbortSignal(controller.signal, () =>
        dump.dump({ appId: APP, deviceId: DEVICE, sessionId: "s-1" }),
      ),
    ).rejects.toThrow("cancelled");

    expect(device.commands).toContain(`shell rm -f ${REMOTE}`);
    expect(device.deviceFiles.size).toBe(0);
    expect(registry.takeOwnedBy(DEVICE, "s-1").deviceFiles).toEqual([]);
  });

  test("a device file that cannot be removed stays registered for session-release cleanup", async () => {
    const { device, registry, dump } = setup();
    device.failing.set("rm -f", "device offline");

    await dump.dump({ appId: APP, deviceId: DEVICE, sessionId: "s-1" });

    expect(registry.takeOwnedBy(DEVICE, "s-1").deviceFiles.map((f) => f.remotePath)).toEqual([
      REMOTE,
    ]);
  });

  describe("when adb rejects the dump call (nonzero remote exit, #14113 review)", () => {
    test("a rejected SecurityException is the typed refusal, and the device copy is removed", async () => {
      const { device, store, registry, dump } = setup();
      device.dumpheapOutput["am dumpheap"] = profiling("am-dumpheap-not-debuggable.txt");
      device.rejectingDumpheap.add("am dumpheap");

      const refusal = await dump.dump({ appId: APP, deviceId: DEVICE, sessionId: "s-1" }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(HeapDumpRefusedError);
      expect((refusal as HeapDumpRefusedError).code).toBe("heap_dump_not_debuggable");
      expect(device.commands).toContain(`shell rm -f ${REMOTE}`);
      expect(store.removed).toHaveLength(1);
      expect(registry.takeOwnedBy(DEVICE, "s-1").deviceFiles).toEqual([]);
    });

    test("a rejected unknown-process output asks for a launch", async () => {
      const { device, dump } = setup();
      device.dumpheapOutput["am dumpheap"] = profiling("am-dumpheap-unknown-process.txt");
      device.rejectingDumpheap.add("am dumpheap");
      await expect(dump.dump({ appId: APP, deviceId: DEVICE })).rejects.toThrow(
        "is not running on emulator-5554",
      );
    });

    test("an unrelated rejection is rethrown unchanged and still cleans up", async () => {
      const { device, registry, dump } = setup();
      const failure = new Error("adb: device offline");
      const original = device.execute.bind(device);
      device.execute = async (args, options) => {
        if (args.join(" ").includes("dumpheap")) {
          throw failure;
        }
        return original(args, options);
      };

      await expect(dump.dump({ appId: APP, deviceId: DEVICE, sessionId: "s-1" })).rejects.toBe(
        failure,
      );

      expect(device.commands).toContain(`shell rm -f ${REMOTE}`);
      expect(registry.takeOwnedBy(DEVICE, "s-1").deviceFiles).toEqual([]);
    });
  });
});
