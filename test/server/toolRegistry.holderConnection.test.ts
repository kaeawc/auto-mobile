import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { subscribeToolCallEndActivity } from "../../src/daemon/toolCallActivity";
import { isSessionlessDeviceRead } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * A deviceId-only call from the MCP connection that holds the device runs as its session (#10994,
 * owner decision 2026-10-09): admitted, readied and credited as use. The same call from any other
 * connection stays a watcher (#10830) or is refused for a mutation (#10698).
 */
describe("deviceId-only calls from the holder's own connection (#10994)", () => {
  // An emulator serial: the session path probes non-emulator serials for keep-awake over adb.
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const HOLDER = "holder-session";
  const HOLDER_CONNECTION = "holder-connection";
  const OTHER_CONNECTION = "watcher-connection";

  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  /** Bodies that ran on the watcher path (the session path runs through the audit runner). */
  let reads: Array<{ readPath: boolean; sessionUuid: unknown }>;
  let unsubscribe: () => void;
  let spies: Array<ReturnType<typeof spyOn>>;

  const lastUsedAt = () => manager.getSession(HOLDER)!.lastUsedAt;
  const fromConnection = (connection: string, name: string, args: Record<string, unknown>) =>
    tools.call(name, { ...args, __mcpSessionId: connection });

  beforeEach(async () => {
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "holder-connection-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    unsubscribe = subscribeToolCallEndActivity(executionTracker, manager, pool);
    tools = new RealToolCallPath([held]).install();
    reads = [];
    ToolRegistry.registerDeviceAware(
      "readProbe",
      "Read-only probe",
      z.object({}).passthrough(),
      async (_device: BootedDevice, args: Record<string, unknown>) => {
        reads.push({ readPath: isSessionlessDeviceRead(), sessionUuid: args.sessionUuid });
        return { success: true };
      },
      { deviceReadOnly: true },
    );
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      held.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      HOLDER_CONNECTION,
    );
    manager.setDeviceReadiness(HOLDER, "automationReady");
  });

  afterEach(() => {
    unsubscribe();
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("the holder's observe {deviceId} runs as its session but does not extend the idle window (#10964)", async () => {
    const before = lastUsedAt();
    const expiresBefore = manager.getSession(HOLDER)!.expiresAt;
    timer.advanceTime(90_000);

    await fromConnection(HOLDER_CONNECTION, "observe", { deviceId: held.deviceId });

    expect(tools.runs).toEqual([{ name: "observe", deviceId: held.deviceId, sessionUuid: HOLDER }]);
    expect(tools.watcherResolutions).toBe(0);
    // No read counts as activity, not even the owner's own (owner decision 2026-10-09).
    expect(lastUsedAt()).toBe(before);
    expect(manager.getSession(HOLDER)!.expiresAt).toBe(expiresBefore);
  });

  test("the holder's observe {sessionUuid} does not extend the idle window either (#10964)", async () => {
    const before = lastUsedAt();
    const expiresBefore = manager.getSession(HOLDER)!.expiresAt;
    timer.advanceTime(30_000);

    await tools.call("observe", { sessionUuid: HOLDER });

    expect(tools.runs).toEqual([{ name: "observe", deviceId: held.deviceId, sessionUuid: HOLDER }]);
    expect(lastUsedAt()).toBe(before);
    expect(manager.getSession(HOLDER)!.expiresAt).toBe(expiresBefore);
  });

  test("an owner that only observes every 30 s loses its device at the idle window (#10964)", async () => {
    const expiresAt = manager.getSession(HOLDER)!.expiresAt;
    while (timer.now() + 30_000 < expiresAt) {
      timer.advanceTime(30_000);
      await fromConnection(HOLDER_CONNECTION, "observe", { deviceId: held.deviceId });
      expect(manager.getSession(HOLDER)!.expiresAt).toBe(expiresAt);
    }
    timer.setCurrentTime(expiresAt + 1);

    expect(manager.getSessionForNewExecution(HOLDER)).toBeNull();
  });

  test("an owner that taps by deviceId every 30 s keeps its device past the idle window (#10964)", async () => {
    const firstExpiry = manager.getSession(HOLDER)!.expiresAt;
    for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 30_000) {
      timer.advanceTime(30_000);
      await fromConnection(HOLDER_CONNECTION, "tapOn", { deviceId: held.deviceId, text: "Next" });
    }

    expect(timer.now()).toBeGreaterThan(firstExpiry);
    expect(manager.getSessionForNewExecution(HOLDER)).not.toBeNull();
    expect(manager.getSession(HOLDER)!.expiresAt).toBeGreaterThan(timer.now());
  });

  test("another connection's read stays a watcher with no readiness; the holder's takes its session path; neither is credited", async () => {
    const before = lastUsedAt();
    timer.advanceTime(30_000);

    await fromConnection(OTHER_CONNECTION, "readProbe", { deviceId: held.deviceId });
    expect(reads).toEqual([{ readPath: true, sessionUuid: undefined }]);
    expect(tools.watcherResolutions).toBe(1);
    expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
    expect(lastUsedAt()).toBe(before);

    await fromConnection(HOLDER_CONNECTION, "readProbe", { deviceId: held.deviceId });
    // The session path runs the body through the audit runner, not the watcher's direct call.
    expect(reads).toHaveLength(1);
    expect(tools.runs).toEqual([
      { name: "readProbe", deviceId: held.deviceId, sessionUuid: HOLDER },
    ]);
    // Session readiness (already automationReady here), not the watcher's booted-list lookup.
    expect(tools.watcherResolutions).toBe(1);
    // The holder's read is not use either (#10964).
    expect(lastUsedAt()).toBe(before);
  });

  test("a sessionless call with no forwarded connection stays a watcher", async () => {
    const before = lastUsedAt();
    timer.advanceTime(30_000);

    await tools.call("readProbe", { deviceId: held.deviceId });

    expect(reads).toEqual([{ readPath: true, sessionUuid: undefined }]);
    expect(lastUsedAt()).toBe(before);
  });

  test("the holder's tapOn {deviceId} is admitted as its session and counts as use", async () => {
    const before = lastUsedAt();
    timer.advanceTime(45_000);

    await fromConnection(HOLDER_CONNECTION, "tapOn", {
      deviceId: held.deviceId,
      text: "Submit",
    });

    expect(tools.runs).toEqual([{ name: "tapOn", deviceId: held.deviceId, sessionUuid: HOLDER }]);
    expect(lastUsedAt()).toBe(before + 45_000);
  });

  test("another connection's tapOn {deviceId} is refused, never drives the device and is not use", async () => {
    const before = lastUsedAt();
    timer.advanceTime(45_000);

    const refusal = await fromConnection(OTHER_CONNECTION, "tapOn", {
      deviceId: held.deviceId,
      text: "Submit",
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string },
    );

    expect(refusal?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(tools.runs).toEqual([]);
    expect(lastUsedAt()).toBe(before);
  });

  test("a released holder's connection no longer adopts the device", async () => {
    await manager.releaseSession(HOLDER);
    expect(
      pool.resolveOwnedDeviceSessionForMcpSession(HOLDER_CONNECTION, held.deviceId),
    ).toBeUndefined();
  });
});
