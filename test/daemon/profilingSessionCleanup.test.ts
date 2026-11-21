import { describe, expect, spyOn, test } from "bun:test";
import { registerProfilingSessionCleanup } from "../../src/daemon/profilingSessionCleanup";
import { cleanupSessionProfiling } from "../../src/features/profiling/profilingCleanup";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { AndroidHeapDump } from "../../src/features/profiling/AndroidHeapDump";
import { ProfilingRegistry } from "../../src/features/profiling/ProfilingRegistry";
import { logger } from "../../src/utils/logger";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeProfilingDevice, FakeProfilingStore } from "../fakes/FakeProfilingDevice";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const OTHER = "emulator-5556";
const LEFTOVER = "/data/local/tmp/automobile-heap-h9.hprof";

function setup() {
  const device = new FakeProfilingDevice();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const registry = new ProfilingRegistry();
  const store = new FakeProfilingStore(device);
  const manager = new FakeSessionCleanupManager();
  registerProfilingSessionCleanup(manager, { registry, adbFor: () => device });
  return { device, registry, store, manager, timer };
}

function leaveFile(
  { device, registry }: ReturnType<typeof setup>,
  sessionId: string | undefined,
  deviceId = DEVICE,
  remotePath = LEFTOVER,
): void {
  device.deviceFiles.set(remotePath, 123);
  registry.addDeviceFile({ deviceId, sessionId, remotePath });
}

describe("registerProfilingSessionCleanup (#14113)", () => {
  test("a heap dump file left on the device by an interrupted dump is removed on release", async () => {
    const ctx = setup();
    leaveFile(ctx, "s-1");

    ctx.manager.release("s-1", DEVICE);
    await ctx.manager.settle();

    expect(ctx.device.deviceFiles.has(LEFTOVER)).toBe(false);
    expect(ctx.manager.pendingCleanups.map(({ deviceId, bound }) => [deviceId, bound])).toEqual([
      [DEVICE, { name: expect.any(String), leftover: expect.any(String) }],
    ]);
  });

  test("an unbind off the device cleans up the same way", async () => {
    const ctx = setup();
    leaveFile(ctx, "s-1");

    ctx.manager.unbind("s-1", DEVICE);
    await ctx.manager.settle();

    expect(ctx.device.deviceFiles.size).toBe(0);
  });

  test("another session's file, another device and sessionless files are left alone", async () => {
    const ctx = setup();
    leaveFile(ctx, "s-1");
    leaveFile(ctx, undefined, OTHER, "/data/local/tmp/other.hprof");

    ctx.manager.release("s-2", DEVICE);
    ctx.manager.release("s-1", OTHER);
    await ctx.manager.settle();

    expect(ctx.manager.pendingCleanups).toEqual([]);
    expect(ctx.device.deviceFiles.size).toBe(2);
  });

  test("a terminal upgrade of a finished release and a replaced device do not touch the device", async () => {
    const ctx = setup();
    leaveFile(ctx, "s-1");
    const commands = ctx.device.commands.length;

    ctx.manager.release("s-1", DEVICE, true);
    expect(ctx.device.commands.length).toBe(commands);

    ctx.manager.release("s-1", DEVICE, false, true);
    await ctx.manager.settle();
    expect(ctx.device.commands.length).toBe(commands);
    expect(ctx.manager.pendingCleanups).toEqual([]);
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

  test("cleanup run from inside a cancelled request still removes the file (#14113 review)", async () => {
    const ctx = setup();
    leaveFile(ctx, "s-1");
    const controller = new AbortController();
    controller.abort();

    const report = await runWithAbortSignal(controller.signal, () =>
      cleanupSessionProfiling(DEVICE, ctx.registry.takeOwnedBy(DEVICE, "s-1"), ctx.device),
    );

    expect(report).toMatchObject({ removedFiles: [LEFTOVER], errors: [] });
    expect(ctx.device.deviceFiles.size).toBe(0);
  });

  test("a file that cannot be removed is reported, not claimed removed", async () => {
    const { device, registry } = setup();
    registry.addDeviceFile({ deviceId: DEVICE, sessionId: "s-1", remotePath: "/data/local/tmp/x" });
    device.failing.set("rm -f", "device offline");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const report = await cleanupSessionProfiling(
        DEVICE,
        registry.takeOwnedBy(DEVICE, "s-1"),
        device,
      );
      expect(report.removedFiles).toEqual([]);
      expect(report.errors).toEqual(["remove /data/local/tmp/x: failed"]);
    } finally {
      warn.mockRestore();
    }
  });
});
