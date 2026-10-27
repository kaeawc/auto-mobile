import { describe, expect, test, spyOn } from "bun:test";
import { sessionDeviceBinding, sessionDeviceInfo } from "../../src/daemon/sessionDeviceBinding";
import { withAdmittedSessionEcho } from "../../src/server/routedSessionEcho";
import { executionTracker } from "../../src/daemon/executionTracker";
import {
  ROUTED_SESSION_META_KEY,
  SESSION_DEVICE_META_KEY,
} from "../../src/daemon/routedSessionMeta";
import { handleSessionInfo, handleActiveSessions } from "../../src/daemon/daemonRequestHandlers";
import { defaultDaemonContext } from "../../src/daemon/daemonContext";
import {
  SessionDeviceReboundBroadcasterClass,
  type SessionDeviceRebound,
} from "../../src/daemon/sessionDeviceReboundBroadcast";
import { logger } from "../../src/utils/logger";
import { installSessionManagerCleanup, makeSessionManager } from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();

describe("session device binding", () => {
  test("defaults to generation zero and omits unknown optional identity", () => {
    expect(sessionDeviceBinding({ sessionId: "s", assignedDevice: "a" })).toEqual({
      sessionUuid: "s",
      deviceId: "a",
      generation: 0,
    });
    expect(sessionDeviceInfo({ sessionId: "s", assignedDevice: "a", stableDeviceId: "P" })).toEqual(
      {},
    );
  });

  test("serial-changing rebinds publish once after indexes change; same-serial force preserves identity", async () => {
    const seen: SessionDeviceRebound[] = [];
    const manager = makeSessionManager({
      fakeBarrier: true,
      sessionDeviceReboundEmitter: {
        emit: (event) => {
          expect(manager.getDeviceForSession(event.sessionId)).toBe(event.deviceId);
          expect(manager.getSessionForDevice(event.deviceId)).toBe(event.sessionId);
          seen.push(event);
        },
      },
    });
    const original = await manager.createSession("s", "a", "android", { stableDeviceId: "Pixel" });
    await manager.rebindSession("s", "a", "android", { force: true });
    expect(sessionDeviceBinding(original)).toEqual({
      sessionUuid: "s",
      deviceId: "a",
      stableDeviceId: "Pixel",
      generation: 0,
    });
    expect(seen).toHaveLength(0);
    expect(await manager.rebindSession("s", "b", "android", { recovery: true })).toBe(original);
    expect(seen).toEqual([
      {
        sessionId: "s",
        previousDeviceId: "a",
        deviceId: "b",
        stableDeviceId: "Pixel",
        avdName: "Pixel",
        generation: 1,
      },
    ]);
    await manager.rebindSession("s", "b", "android", { force: true });
    expect(seen).toHaveLength(1);
    expect(sessionDeviceBinding(original)).toMatchObject({ generation: 1, previousDeviceId: "a" });
    await manager.rebindSession("s", "c", "android", { recovery: true });
    expect(seen[1]).toMatchObject({ generation: 2, previousDeviceId: "b", deviceId: "c" });
  });

  test("a client-chosen move changes the serial without a generation bump or a notification (#15456)", async () => {
    const seen: SessionDeviceRebound[] = [];
    const manager = makeSessionManager({
      fakeBarrier: true,
      sessionDeviceReboundEmitter: { emit: (event) => seen.push(event) },
    });
    const original = await manager.createSession("s", "a", "android", { stableDeviceId: "Pixel" });
    await manager.rebindSession("s", "b", "android");
    expect(original.assignedDevice).toBe("b");
    expect(sessionDeviceBinding(original)).toEqual({
      sessionUuid: "s",
      deviceId: "b",
      stableDeviceId: "Pixel",
      generation: 0,
    });
    expect(sessionDeviceInfo(original)).toEqual({});
    expect(seen).toEqual([]);
    // A later recovery counts from the manual move: one real recovery, generation one.
    await manager.rebindSession("s", "c", "android", { recovery: true });
    expect(seen).toEqual([
      expect.objectContaining({ previousDeviceId: "b", deviceId: "c", generation: 1 }),
    ]);
  });

  test("a failing injected emitter warns without rejecting the published rebind", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const manager = makeSessionManager({
      fakeBarrier: true,
      sessionDeviceReboundEmitter: {
        emit: () => {
          throw new Error("broken sink");
        },
      },
    });
    try {
      await manager.createSession("s", "a", "android");
      expect(await manager.rebindSession("s", "b", "android", { recovery: true })).toMatchObject({
        assignedDevice: "b",
        deviceGeneration: 1,
        previousDeviceId: "a",
      });
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test("session-info and active-sessions expose the same current binding", async () => {
    const manager = makeSessionManager({ fakeBarrier: true });
    await manager.createSession("s", "a", "android", { stableDeviceId: "Pixel" });
    await manager.rebindSession("s", "b", "android", { recovery: true });
    const request = {
      id: "r",
      type: "mcp_request" as const,
      method: "daemon/sessionInfo",
      params: { sessionId: "s", includeSessions: true },
    };
    const info = await handleSessionInfo(request, { getSessionManager: () => manager });
    const active = await handleActiveSessions(request, {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => {
        throw new Error("not needed");
      },
      getDeviceSessionRegistry: () => {
        throw new Error("not needed");
      },
    });
    const fields = {
      stableDeviceId: "Pixel",
      previousDeviceId: "a",
      deviceGeneration: 1,
      assignedDevice: "b",
    };
    expect(info.result).toMatchObject(fields);
    expect(active.result?.sessions).toEqual([expect.objectContaining(fields)]);
  });

  test("admitted echo adds binding only after a serial change and preserves other metadata", async () => {
    const manager = makeSessionManager({ fakeBarrier: true });
    await manager.createSession("s", "a", "android", { stableDeviceId: "Pixel" });
    const execution = executionTracker.startExecution("tapOn", undefined, "s");
    executionTracker.markSessionAdmitted(execution.id);
    const context = { ...defaultDaemonContext, sessionManager: () => manager };
    const result: { content: unknown[]; _meta: Record<string, unknown> } = {
      content: [],
      _meta: { caller: "kept" },
    };
    try {
      expect(withAdmittedSessionEcho(result, execution.id, context)).toEqual({
        ...result,
        _meta: { caller: "kept", [ROUTED_SESSION_META_KEY]: "s" },
      });
      await manager.rebindSession("s", "b", "android", { recovery: true });
      expect(withAdmittedSessionEcho(result, execution.id, context)).toEqual({
        ...result,
        _meta: {
          caller: "kept",
          [ROUTED_SESSION_META_KEY]: "s",
          [SESSION_DEVICE_META_KEY]: {
            sessionUuid: "s",
            deviceId: "b",
            stableDeviceId: "Pixel",
            generation: 1,
            previousDeviceId: "a",
          },
        },
      });
      expect(withAdmittedSessionEcho(result, "not-admitted", context)).toBe(result);
    } finally {
      executionTracker.endExecution(execution.id);
    }
  });

  test("a label-routed call reports its derived session's device, not the base session's", async () => {
    const manager = makeSessionManager({ fakeBarrier: true });
    await manager.createSession("s", "a", "android");
    const other = await manager.createSession("t", "c", "android", { stableDeviceId: "Tablet" });
    await manager.rebindSession("t", "d", "android", { recovery: true });
    const derived = { ...other, sessionId: "s:second" };
    const peek = manager.peekSession.bind(manager);
    spyOn(manager, "peekSession").mockImplementation((id) =>
      id === "s:second" ? derived : peek(id),
    );
    spyOn(manager, "getDeviceLabels").mockImplementation((id) =>
      id === "s" ? { second: "s:second" } : undefined,
    );
    const execution = executionTracker.startExecution("tapOn", undefined, "s:second");
    executionTracker.markSessionAdmitted(execution.id);
    const context = { ...defaultDaemonContext, sessionManager: () => manager };
    const result: { content: unknown[]; _meta?: Record<string, unknown> } = { content: [] };
    try {
      const echoed = withAdmittedSessionEcho(result, execution.id, context);
      expect(echoed._meta?.[ROUTED_SESSION_META_KEY]).toBe("s");
      expect(echoed._meta?.[SESSION_DEVICE_META_KEY]).toEqual({
        sessionUuid: "s:second",
        deviceId: "d",
        stableDeviceId: "Tablet",
        previousDeviceId: "c",
        generation: 1,
      });
    } finally {
      executionTracker.endExecution(execution.id);
    }
  });

  test("broadcaster isolates throwing listeners and supports unsubscription", () => {
    const broadcaster = new SessionDeviceReboundBroadcasterClass();
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const seen: SessionDeviceRebound[] = [];
    const event = { sessionId: "s", previousDeviceId: "a", deviceId: "b", generation: 1 };
    const stopBad = broadcaster.subscribe(() => {
      throw new Error("broken");
    });
    const stop = broadcaster.subscribe((binding) => {
      seen.push(binding);
    });
    try {
      broadcaster.emit(event);
      expect(seen).toEqual([event]);
      expect(warning).toHaveBeenCalledTimes(1);
      stop();
      stopBad();
      broadcaster.emit(event);
      expect(seen).toHaveLength(1);
    } finally {
      stop();
      stopBad();
      warning.mockRestore();
    }
  });
});
