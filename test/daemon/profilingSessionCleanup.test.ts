import { describe, expect, spyOn, test } from "bun:test";
import { registerProfilingSessionCleanup } from "../../src/daemon/profilingSessionCleanup";
import { cleanupSessionProfiling } from "../../src/features/profiling/profilingCleanup";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { AndroidHeapDump } from "../../src/features/profiling/AndroidHeapDump";
import { AndroidTraceCapture } from "../../src/features/profiling/AndroidTraceCapture";
import { ProfilingRegistry } from "../../src/features/profiling/ProfilingRegistry";
import { logger } from "../../src/utils/logger";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeProfilingDevice, FakeProfilingStore } from "../fakes/FakeProfilingDevice";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const OTHER = "emulator-5556";
const TRACE_FILE = "/data/misc/perfetto-traces/automobile-trace-t1.perfetto-trace";

function setup() {
  const device = new FakeProfilingDevice();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const registry = new ProfilingRegistry();
  const store = new FakeProfilingStore(device);
  const manager = new FakeSessionCleanupManager();
  registerProfilingSessionCleanup(manager, { registry, adbFor: () => device, timer });
  const capture = new AndroidTraceCapture({
    adb: device,
    timer,
    idGenerator: new FakeIdGenerator(["t1", "t2"]),
    registry,
    store,
  });
  return { device, registry, store, manager, capture, timer };
}

describe("registerProfilingSessionCleanup (#14113)", () => {
  test("release stops the session's orphaned trace and deletes its device file without pulling", async () => {
    const { device, manager, registry, capture } = setup();
    await capture.start({ deviceId: DEVICE, sessionId: "s-1" });
    expect(device.runningPids.size).toBe(1);

    manager.release("s-1", DEVICE);
    await manager.settle();

    expect(device.runningPids.size).toBe(0);
    expect(device.deviceFiles.has(TRACE_FILE)).toBe(false);
    expect(device.commands.some((c) => c.startsWith("pull"))).toBe(false);
    expect(registry.traceOnDevice(DEVICE)).toBeUndefined();
    expect(manager.pendingCleanups.map(({ deviceId, bound }) => [deviceId, bound])).toEqual([
      [DEVICE, { name: expect.any(String), leftover: expect.any(String) }],
    ]);
  });

  test("an unbind off the device cleans up the same way", async () => {
    const { device, manager, capture } = setup();
    await capture.start({ deviceId: DEVICE, sessionId: "s-1" });

    manager.unbind("s-1", DEVICE);
    await manager.settle();

    expect(device.runningPids.size).toBe(0);
    expect(device.deviceFiles.size).toBe(0);
  });

  test("a heap dump file left on the device by an interrupted dump is removed", async () => {
    const { device, manager, registry } = setup();
    const leftover = "/data/local/tmp/automobile-heap-h9.hprof";
    device.deviceFiles.set(leftover, 123);
    registry.addDeviceFile({ deviceId: DEVICE, sessionId: "s-1", remotePath: leftover });

    manager.release("s-1", DEVICE);
    await manager.settle();

    expect(device.deviceFiles.has(leftover)).toBe(false);
  });

  test("another session's trace, another device and sessionless traces are left alone", async () => {
    const { device, manager, registry, capture } = setup();
    await capture.start({ deviceId: DEVICE, sessionId: "s-1" });
    const unowned = new AndroidTraceCapture({
      adb: device,
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(["t2"]),
      registry,
      store: new FakeProfilingStore(device),
    });
    await unowned.start({ deviceId: OTHER });

    manager.release("s-2", DEVICE);
    manager.release("s-1", OTHER);
    await manager.settle();

    expect(manager.pendingCleanups).toEqual([]);
    expect(registry.getTrace("trace-t1")).toBeDefined();
    expect(registry.getTrace("trace-t2")).toBeDefined();
  });

  test("a terminal upgrade of a finished release and a replaced device do not touch the device", async () => {
    const { device, manager, capture } = setup();
    await capture.start({ deviceId: DEVICE, sessionId: "s-1" });
    const commands = device.commands.length;

    manager.release("s-1", DEVICE, true);
    expect(device.commands.length).toBe(commands);

    manager.release("s-1", DEVICE, false, true);
    await manager.settle();
    expect(device.commands.length).toBe(commands);
    expect(manager.pendingCleanups).toEqual([]);
  });

  test("a recorder that cannot be stopped is logged, its file is still removed and the device is released", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { device, manager, capture } = setup();
      await capture.start({ deviceId: DEVICE, sessionId: "s-1" });
      device.failing.set("kill -TERM", "device offline");

      manager.release("s-1", DEVICE);
      await manager.settle();

      expect(device.deviceFiles.has(TRACE_FILE)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a heap dump in flight when the session is released is cleaned by the same seam", async () => {
    const { device, manager, registry, store, timer } = setup();
    device.packageDump = "    pkgFlags=[ DEBUGGABLE ]\n";
    const dump = new AndroidHeapDump({
      adb: device,
      timer,
      idGenerator: new FakeIdGenerator(["h1"]),
      registry,
      store,
    });
    const original = device.execute.bind(device);
    device.execute = async (args) => {
      if (args[0] === "pull") {
        manager.release("s-1", DEVICE);
        await manager.settle();
      }
      return original(args);
    };

    await expect(
      dump.dump({ appId: "com.example.app", deviceId: DEVICE, sessionId: "s-1" }),
    ).rejects.toThrow("is empty");
    expect(device.deviceFiles.size).toBe(0);
  });

  test("cleanup run from inside a cancelled request still stops the recorder and removes the file (#14113 review)", async () => {
    const { device, registry, capture, timer } = setup();
    await capture.start({ deviceId: DEVICE, sessionId: "s-1" });
    const controller = new AbortController();
    controller.abort();

    const report = await runWithAbortSignal(controller.signal, () =>
      cleanupSessionProfiling(DEVICE, registry.takeOwnedBy(DEVICE, "s-1"), device, { timer }),
    );

    expect(report).toMatchObject({ stoppedTraces: ["trace-t1"], errors: [] });
    expect(device.runningPids.size).toBe(0);
    expect(device.deviceFiles.size).toBe(0);
  });

  test("a file that cannot be removed is reported, not claimed removed", async () => {
    const { device, registry, timer } = setup();
    registry.addDeviceFile({ deviceId: DEVICE, sessionId: "s-1", remotePath: "/data/local/tmp/x" });
    device.failing.set("rm -f", "device offline");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const report = await cleanupSessionProfiling(
        DEVICE,
        registry.takeOwnedBy(DEVICE, "s-1"),
        device,
        { timer },
      );
      expect(report.removedFiles).toEqual([]);
      expect(report.errors).toEqual(["remove /data/local/tmp/x: failed"]);
    } finally {
      warn.mockRestore();
    }
  });
});
