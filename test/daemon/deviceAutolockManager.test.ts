import { afterEach, describe, expect, test } from "bun:test";
import {
  DeviceAutolockManager,
  type DeviceAutolockPoolPort,
} from "../../src/daemon/deviceAutolockManager";
import type { PooledDevice, SessionAssignmentSnapshot } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { runWithAbortSignal } from "../../src/utils/AbortContext";

function harness() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const device: PooledDevice = {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation: 1,
  };
  const devices = new Map([[device.id, device]]);
  const events: string[] = [];
  const quarantined = new Set<string>();
  let deviceManager = { getBootedDevices: async () => [] };
  let daemonSessionId = "daemon-test";
  let persist: DeviceSessionRepository["markAutolockSession"] = async () => {
    events.push("persist");
  };
  const port: DeviceAutolockPoolPort = {
    getSessionManager: () => sessions,
    getDaemonSessionId: () => daemonSessionId,
    getDevice: (id) => devices.get(id),
    withAssignmentLock: async (operation) => {
      events.push("lock");
      const result = await operation();
      events.push("unlock");
      return result;
    },
    withTargetDeviceDiscovery: async ({ operation, deviceId }) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const capturedEntry = devices.get(deviceId);
        const bootedDevices = capturedEntry ? undefined : await deviceManager.getBootedDevices();
        events.push("lock");
        const result = await operation({ capturedEntry, bootedDevices });
        events.push("unlock");
        if (result !== undefined) {
          return result;
        }
        events.push("retry");
      }
      throw new Error("Snapshot retries exhausted");
    },
    assertRuntimeIdentity: () => events.push("identity"),
    assertNotReservedForShutdown: () => events.push("shutdown-check"),
    recordSourceAndroidAvd: () => events.push("source"),
    notifyTargetDeviceReady: () => events.push("ready"),
    trackStartedDeviceProcess: async () => {
      events.push("process");
    },
    assertIdleDeviceAssignable: () => {
      events.push("idle-check");
    },
    validateOrReloadIdlePooledDevice: async ({ device: pooled }) => pooled,
    assertDeviceCleanupComplete: () => events.push("cleanup-check"),
    snapshotSessionAssignment: (pooled): SessionAssignmentSnapshot => ({
      sessionId: pooled.sessionId,
      status: pooled.status,
      lastUsedAt: pooled.lastUsedAt,
      assignmentCount: pooled.assignmentCount,
      errorCount: pooled.errorCount,
      autolockSessionId: pooled.autolockSessionId,
    }),
    nextLastUsedAt: () => timer.now() + 1,
    createSessionOrRestore: async (_pooled, _snapshot, create) => await create(),
    stableDeviceIdFor: (pooled) => pooled.name,
    recordMcpSessionOwnership: () => events.push("ownership"),
    restoreSessionAssignment: (pooled, snapshot) => {
      events.push("restore");
      Object.assign(pooled, snapshot);
    },
    isSessionAssignmentCurrent: (pooled, session) =>
      devices.get(pooled.id) === pooled && pooled.sessionId === session.sessionId,
    getPooledSessionIdentity: (pooled) =>
      pooled.sessionId ? (sessions.getSession(pooled.sessionId) ?? undefined) : undefined,
    getMcpSessionRecoveryDevice: () => undefined,
    isAdbServerResetQuarantined: (id) => quarantined.has(id),
  };
  const manager = new DeviceAutolockManager(
    port,
    {
      markAutolockSession: (id, input) => persist(id, input),
    },
    new CountingIdGenerator("autolock-test"),
  );
  return {
    manager,
    port,
    sessions,
    timer,
    device,
    devices,
    events,
    quarantined,
    setPersistence: (next: typeof persist) => {
      persist = next;
    },
    setDeviceManager: (next: typeof deviceManager) => {
      deviceManager = next;
    },
    setDaemonSessionId: (next: string) => {
      daemonSessionId = next;
    },
  };
}

describe("DeviceAutolockManager", () => {
  const priorAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  afterEach(() => {
    if (priorAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = priorAutolock;
    }
  });

  test("publishes readiness and ownership after the pool checks and before persistence", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, events } = harness();
    const id = await manager.autolockDevice(device.id, "android", "mcp-1");

    expect(device.sessionId).toBe(id);
    expect(device.autolockSessionId).toBe(id);
    expect(sessions.getDeviceReadiness(id!)).toBe("automationReady");
    expect(manager.resolveAutolockSessionForMcpSession("mcp-1")).toBe(id);
    expect(events).toEqual([
      "lock",
      "identity",
      "shutdown-check",
      "source",
      "ready",
      "process",
      "idle-check",
      "cleanup-check",
      "ownership",
      "persist",
      "unlock",
    ]);
    sessions.stopCleanupTimer();
  });

  test("retries when validation replaces the captured entry", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, port, devices, device, events, sessions } = harness();
    const replacement = { ...device, incarnation: 2 };
    port.validateOrReloadIdlePooledDevice = async ({ device: current }) => {
      if (current === device) {
        devices.set(device.id, replacement);
        return undefined;
      }
      return current;
    };
    const id = await manager.autolockDevice(device.id, "android", "mcp-1");
    expect(events.filter((event) => event === "retry")).toHaveLength(1);
    expect(device.sessionId).toBeNull();
    expect(replacement.sessionId).toBe(id);
    expect(replacement.assignmentCount).toBe(1);
    expect(events.filter((event) => event === "persist")).toHaveLength(1);
    sessions.stopCleanupTimer();
  });

  test("retries when the entry changes after owned-session reuse yields", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, port, devices, device, events, sessions } = harness();
    const replacement = { ...device, incarnation: 2 };
    port.validateOrReloadIdlePooledDevice = async ({ device: current }) => {
      if (current === device) {
        // Validation returns this entry first; reuseOwnedAutolockSession's await
        // then lets a newer pool incarnation win before the final claim guard.
        queueMicrotask(() => devices.set(device.id, replacement));
      }
      return current;
    };
    const id = await manager.autolockDevice(device.id, "android", "mcp-1");
    expect(events.filter((event) => event === "retry")).toHaveLength(1);
    expect(device.sessionId).toBeNull();
    expect(replacement.sessionId).toBe(id);
    expect(replacement.assignmentCount).toBe(1);
    expect(events.filter((event) => event === "persist")).toHaveLength(1);
    sessions.stopCleanupTimer();
  });

  test("clears only the released lock and keeps a replacement route", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, timer } = harness();
    const first = await manager.autolockDevice(device.id, "android", "mcp-1");
    device.autolockSessionId = "replacement";
    device.sessionId = "replacement";
    timer.advanceTime(1);
    manager.clearReleasedAutolockState(first!, device.id);
    expect(device.autolockSessionId).toBe("replacement");
    expect(manager.captureAutolockSessionForMcpSession("mcp-1")).toBe(first);
    sessions.stopCleanupTimer();
  });

  test("clears only the captured entry's rebind lock and preserves MCP routes", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device } = harness();
    const id = await manager.autolockDevice(device.id, "android", "mcp-1");
    await manager.attachAutolockSessionToMcpSession(id!, "mcp-2");

    manager.clearRebindAutolockLock(id!, device.id, device);

    expect(device.autolockSessionId).toBeUndefined();
    expect(device.sessionId).toBe(id);
    expect(device.status).toBe("busy");
    expect(manager.captureAutolockSessionForMcpSession("mcp-1")).toBe(id);
    expect(manager.captureAutolockSessionForMcpSession("mcp-2")).toBe(id);
    sessions.stopCleanupTimer();
  });

  test("does not clear a same-serial replacement entry or its MCP route", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, devices } = harness();
    const id = await manager.autolockDevice(device.id, "android", "mcp-1");
    const replacement = { ...device, incarnation: device.incarnation + 1 };
    devices.set(device.id, replacement);

    manager.clearRebindAutolockLock(id!, device.id, device);

    expect(device.autolockSessionId).toBe(id);
    expect(replacement.autolockSessionId).toBe(id);
    expect(manager.captureAutolockSessionForMcpSession("mcp-1")).toBe(id);
    expect(
      manager.resolveAutolockSessionForMcpSession("mcp-1", "android", undefined, device.id),
    ).toBe(id);
    sessions.stopCleanupTimer();
  });

  test("does not clear another session's lock on the captured entry", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device } = harness();
    const id = await manager.autolockDevice(device.id, "android", "mcp-1");
    device.autolockSessionId = "another-owner";
    const snapshot = { ...device };

    manager.clearRebindAutolockLock(id!, device.id, device);

    expect(device).toEqual(snapshot);
    expect(manager.captureAutolockSessionForMcpSession("mcp-1")).toBe(id);
    sessions.stopCleanupTimer();
  });

  test("reuses the caller's owned autolock session", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, events } = harness();
    const first = await manager.autolockDevice(device.id, "android", "mcp-1");
    const assignmentCount = device.assignmentCount;
    const second = await manager.autolockDevice(device.id, "android", "mcp-1");
    expect(second).toBe(first);
    expect(device.assignmentCount).toBe(assignmentCount);
    expect(events.filter((event) => event === "persist")).toHaveLength(1);
    sessions.stopCleanupTimer();
  });

  test("reads the current device manager and daemon identity through the port", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const {
      manager,
      sessions,
      device,
      devices,
      events,
      setDeviceManager,
      setDaemonSessionId,
      setPersistence,
    } = harness();
    devices.delete(device.id);
    setDeviceManager({
      getBootedDevices: async () => {
        events.push("replacement-discovery");
        return [];
      },
    });
    await expect(manager.autolockDevice(device.id, "android", "mcp-1")).rejects.toThrow(
      "not available for autolock",
    );
    expect(events).toContain("replacement-discovery");
    devices.set(device.id, device);
    setDaemonSessionId("replacement-daemon");
    let persistedDaemon: string | null | undefined;
    setPersistence(async (_id, input) => {
      persistedDaemon = input.daemonSessionId;
    });
    await manager.autolockDevice(device.id, "android", "mcp-1");
    expect(persistedDaemon).toBe("replacement-daemon");
    sessions.stopCleanupTimer();
  });

  test("reports ambiguous owned selector candidates", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, devices } = harness();
    const first = await manager.autolockDevice(device.id, "android", "mcp-1");
    const other: PooledDevice = {
      ...device,
      id: "emulator-5556",
      name: "Other",
      sessionId: null,
      autolockSessionId: undefined,
      assignmentCount: 0,
      status: "idle",
    };
    devices.set(other.id, other);
    const second = await manager.autolockDevice(other.id, "android", "mcp-1");
    expect(() => manager.resolveAutolockSessionForMcpSession("mcp-1", "android")).toThrow(
      /Candidate sessions:.*emulator-5554.*emulator-5556/,
    );
    expect(
      manager.resolveAutolockSessionForMcpSession("mcp-1", "android", undefined, other.id),
    ).toBe(second);
    expect(first).not.toBe(second);
    sessions.stopCleanupTimer();
  });

  test("routes a quarantined ADB-reset session to its original device", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, devices, quarantined } = harness();
    const id = await manager.autolockDevice(device.id, "android", "mcp-1");
    devices.delete(device.id);
    quarantined.add(id!);
    expect(
      manager.resolveAutolockSessionForMcpSession("mcp-1", "android", undefined, device.id),
    ).toBe(id);
    expect(
      manager.resolveAutolockSessionForMcpSession("mcp-1", "ios", undefined, device.id),
    ).toBeUndefined();
    sessions.stopCleanupTimer();
  });

  test("if-absent attachment preserves an existing default", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, devices } = harness();
    const first = await manager.autolockDevice(device.id, "android", "mcp-1");
    const other: PooledDevice = {
      ...device,
      id: "emulator-5556",
      name: "Other",
      sessionId: null,
      autolockSessionId: undefined,
      assignmentCount: 0,
      status: "idle",
    };
    devices.set(other.id, other);
    const second = await manager.autolockDevice(other.id, "android", "mcp-2");
    await manager.attachAutolockSessionToMcpSession(second!, "mcp-1", "if-absent");
    expect(manager.captureAutolockSessionForMcpSession("mcp-1")).toBe(first);
    expect(
      manager.resolveAutolockSessionForMcpSession("mcp-1", "android", undefined, other.id),
    ).toBe(second);
    sessions.stopCleanupTimer();
  });

  test("restores the assignment when persistence is cancelled", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const { manager, sessions, device, events, setPersistence } = harness();
    const controller = new AbortController();
    setPersistence(async () => {
      controller.abort(new Error("cancelled"));
    });
    await expect(
      runWithAbortSignal(controller.signal, () =>
        manager.autolockDevice(device.id, "android", "mcp-1"),
      ),
    ).rejects.toThrow("cancelled");
    expect(events).toContain("restore");
    expect(device.sessionId).toBeNull();
    expect(device.assignmentCount).toBe(0);
    sessions.stopCleanupTimer();
  });
});
