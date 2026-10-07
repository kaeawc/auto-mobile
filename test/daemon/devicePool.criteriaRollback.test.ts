import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import type { DeviceAllocationRequest } from "../../src/daemon/DeviceCriteriaMatcher";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models/ActionableError";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { logger } from "../../src/utils/logger";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntil } from "../helpers/fakeTimerStepping";

// Pure allocation unit tests: in-memory persistence and fake discovery/time only.
describe("criteria allocation rollback on thrown errors", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let manager: SessionManager;
  let markers: FakeDeviceHealthMarkers;
  let pool: DevicePool;
  const requests: DeviceAllocationRequest[] = ["a", "b", "c"].map((label) => ({
    sessionId: `plan:${label}`,
    criteria: { platform: "android", simulatorType: `device-${label}` },
  }));

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence);
    markers = new FakeDeviceHealthMarkers(timer);
    const devices = ["a", "b", "c"].map((label) => ({
      deviceId: `device-${label}`,
      name: `device-${label}`,
      platform: "android" as const,
    }));
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = devices;
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "criteria-rollback-test", {
        timer,
        deviceManager,
        deviceHealthMarkers: markers,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(devices);
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    timer.reset();
  });

  const expectReleased = (labels: string[]): void => {
    for (const label of labels) {
      expect(pool.getDevice(`device-${label}`)).toMatchObject({ status: "idle", sessionId: null });
      expect(manager.getSession(`plan:${label}`)).toBeNull();
    }
  };

  const expectImmediateRetry = async (): Promise<void> => {
    const assignments = await pool.assignMultipleDevicesByCriteria(requests, 10_000);
    expect([...assignments]).toEqual([
      ["plan:a", "device-a"],
      ["plan:b", "device-b"],
      ["plan:c", "device-c"],
    ]);
  };

  test("third label abort releases partial allocations before rejection", async () => {
    await pool.bindOrReuseDeviceSession("other-owner", "device-c", "android");
    const controller = new AbortController();
    const originalError = new Error("client cancelled criteria allocation");
    const allocation = runWithAbortSignal(controller.signal, () =>
      pool.assignMultipleDevicesByCriteria(requests, 10_000),
    );
    const outcome = allocation.then(
      () => {
        throw new Error("expected allocation to reject");
      },
      (error: unknown) => error,
    );
    await drainUntil(() => timer.getPendingTimeoutCount() === 1, {
      description: "third label waiting after releasing the first two claims",
    });
    expectReleased(["a", "b"]);
    controller.abort(originalError);
    timer.advanceTime(1_000);
    await expect(outcome).resolves.toBe(originalError);
    // No sweep or further fake-time advance: rollback is part of rejection.
    expectReleased(["a", "b"]);
    expect(pool.getDevice("device-c")?.sessionId).toBe("other-owner");
    await manager.releaseSession("other-owner");
    await pool.releaseDevice("device-c", "other-owner");
    await expectImmediateRetry();
  });

  test("third label unhealthy-device error releases the first two allocations", async () => {
    const incarnation = pool.getDeviceIncarnation("device-c");
    if (incarnation === undefined) {
      throw new Error("expected pooled device incarnation");
    }
    markers.mark("device-c", incarnation, "clock");
    const expectedMessage =
      "Unhealthy devices cannot be assigned: 'device-c' (clock, since 0). " +
      "Session state could not be restored. Retry after restoration succeeds, manually restore the state, " +
      "or use killDevice/startDevice to replace the device. Automatic erase/reboot is not performed.";
    const allocation = pool.assignMultipleDevicesByCriteria(requests, 10_000);
    await expect(allocation).rejects.toBeInstanceOf(ActionableError);
    await expect(allocation).rejects.toMatchObject({ message: expectedMessage });
    expectReleased(["a", "b", "c"]);
    markers.clear("device-c");
    await expectImmediateRetry();
  });

  test("third label session-create failure releases the first two allocations", async () => {
    const originalError = new Error("third session persistence rejected");
    const upsert = persistence.upsertActiveSession.bind(persistence);
    const create = spyOn(persistence, "upsertActiveSession").mockImplementation(async (record) => {
      if (record.sessionUuid === "plan:c") {
        throw originalError;
      }
      await upsert(record);
    });
    try {
      await expect(pool.assignMultipleDevicesByCriteria(requests, 10_000)).rejects.toBe(
        originalError,
      );
      expectReleased(["a", "b", "c"]);
      create.mockRestore();
      await expectImmediateRetry();
    } finally {
      create.mockRestore();
    }
  });

  test("a live session whose held device misses its criteria fails fast and is preserved", async () => {
    await pool.bindOrReuseDeviceSession("plan:a", "device-a", "android");
    const heldSession = manager.getSession("plan:a");
    // plan:a holds device-a but asks for device-b. It must not be moved to (or
    // reused through) idle b (#10153); the allocation fails before any claim.
    const reuseRequests: DeviceAllocationRequest[] = [
      { sessionId: "plan:a", criteria: { platform: "android", simulatorType: "device-b" } },
      requests[1],
      requests[2],
    ];
    const create = spyOn(manager, "createSession");
    const release = spyOn(manager, "releaseSession");
    try {
      await expect(pool.assignMultipleDevicesByCriteria(reuseRequests, 10_000)).rejects.toThrow(
        "Session 'plan:a' already holds device 'device-a', but it does not match the requested criteria",
      );
      expect(manager.getSession("plan:a")).toBe(heldSession);
      expect(pool.getDevice("device-a")).toMatchObject({ status: "busy", sessionId: "plan:a" });
      expectReleased(["b", "c"]);
      expect(create.mock.calls).toEqual([]);
      expect(release.mock.calls).toEqual([]);
    } finally {
      create.mockRestore();
      release.mockRestore();
    }
  });

  test("a throwing rollback logs warn and still releases the next allocation", async () => {
    const originalError = new Error("third session rejected");
    const rollbackError = new Error("first device release rejected");
    const createSession = manager.createSession.bind(manager);
    const create = spyOn(manager, "createSession").mockImplementation(async (...args) => {
      if (args[0] === "plan:c") {
        throw originalError;
      }
      return createSession(...args);
    });
    const releaseDevice = pool.releaseDevice.bind(pool);
    const release = spyOn(pool, "releaseDevice").mockImplementation(async (deviceId, sessionId) => {
      if (deviceId === "device-a") {
        throw rollbackError;
      }
      await releaseDevice(deviceId, sessionId);
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(pool.assignMultipleDevicesByCriteria(requests, 10_000)).rejects.toBe(
        originalError,
      );
      expectReleased(["b", "c"]);
      expect(manager.getSession("plan:a")).toBeNull();
      expect(release.mock.calls).toEqual([
        ["device-a", "plan:a"],
        ["device-b", "plan:b"],
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to roll back criteria allocation for plan:a on device-a"),
        rollbackError,
      );
    } finally {
      create.mockRestore();
      release.mockRestore();
      warn.mockRestore();
    }
  });
});
