import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  ManagedExecutionRelease,
  type ManagedExecutionSessions,
  type ManagedExecutionWork,
} from "../../../src/daemon/managedSlots/managedExecutionRelease";
import type { SlotKey } from "../../../src/daemon/managedSlots/slotRegistry";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../../src/daemon/managedExecutionLiveness";
import { logger } from "../../../src/utils/logger";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { DAEMON_RELEASE_EXECUTION_METHOD } from "../../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// #11177: ending a managed execution drains its work and releases its live control, but the slot
// keeps its device: the assignment (binding, generation) survives and generic allocation stays
// excluded. Unsettled work leaves the slot `cleanup_pending` until it settles.

const S1 = "session-1";
const S2 = "session-2";
const DEVICE = "emulator-5554";
const AVD = "Pixel_8_API_35";
const BINDING = { generation: 1, stableDeviceId: AVD };

class FakeWork implements ManagedExecutionWork {
  readonly active = new Map<string, number>();
  /** When false, cancelled work keeps running (an action ignoring its abort). */
  endOnCancel = true;
  readonly cancelled: string[] = [];

  async cancelDeviceSessionExecutions(sessionId: string): Promise<number> {
    this.cancelled.push(sessionId);
    const count = this.active.get(sessionId) ?? 0;
    if (this.endOnCancel) {
      this.active.delete(sessionId);
    }
    return count;
  }

  async waitForDeviceSessionExecutionsToEnd(
    sessionId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.active.has(sessionId)) {
      return true;
    }
    await this.timer.sleep(timeoutMs);
    return !this.active.has(sessionId);
  }

  hasActiveDeviceSessionExecutions(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  constructor(private readonly timer: FakeTimer) {}
}

class FakeSessions implements ManagedExecutionSessions {
  readonly live = new Map<string, string>();
  readonly released: string[] = [];
  readonly forced: string[] = [];
  readonly cleanupInProgress = new Set<string>();
  hangRelease = false;

  isSessionLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  deviceOf(sessionId: string): string | null {
    return this.live.get(sessionId) ?? null;
  }

  releaseSession(sessionId: string): Promise<string | null> {
    if (this.hangRelease) {
      return new Promise(() => {});
    }
    const device = this.live.get(sessionId) ?? null;
    this.live.delete(sessionId);
    this.released.push(sessionId);
    return Promise.resolve(device);
  }

  async forceStuckRelease(sessionId: string): Promise<boolean> {
    this.forced.push(sessionId);
    const device = this.live.get(sessionId);
    this.live.delete(sessionId);
    if (device) {
      this.cleanupInProgress.add(device);
    }
    return true;
  }

  hasDeviceCleanupInProgress(deviceId: string): boolean {
    return this.cleanupInProgress.has(deviceId);
  }
}

describe("managed execution release (daemon/releaseExecution)", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let work: FakeWork;
  let sessions: FakeSessions;
  let drain: ManagedExecutionRelease;
  let key: SlotKey;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = new FakeSlotRegistry(timer);
    work = new FakeWork(timer);
    sessions = new FakeSessions();
    drain = new ManagedExecutionRelease({ registry: async () => registry, work, sessions, timer });
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "runner-a",
      runnerIncarnation: "boot-1",
    });
    if (scope.kind !== "ready") {
      throw new Error(`scope not ready: ${scope.kind}`);
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
    await registry.initSlot(key, { role: "primary", platform: "android", requestedSpec: {} });
    await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: AVD,
        deviceName: "amslot-test-0-g1",
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
      },
    );
    await claim(S1);
  });

  afterEach(() => {
    drain.close();
    warn.mockRestore();
  });

  async function claim(sessionId: string): Promise<void> {
    const claimed = await registry.claimExecution(key, BINDING, {
      daemonId: "daemon",
      pid: 1,
      sessionUuid: sessionId,
    });
    expect(claimed.kind).toBe("claimed");
    sessions.live.set(sessionId, DEVICE);
  }

  test("release drains, ends live control, and keeps the slot's device assignment", async () => {
    work.active.set(S1, 2);

    const result = await drain.releaseExecution(S1);

    expect(result).toMatchObject({
      sessionId: S1,
      outcome: "reusable_for_this_slot",
      settlement: "confirmed",
      alreadyReleased: false,
      cancellationRequested: 2,
      releaseForced: false,
      device: DEVICE,
      slotFailures: [],
    });
    expect(result.slots).toEqual([
      expect.objectContaining({ slotIndex: 0, stableDeviceId: AVD, generation: 1, state: "ready" }),
    ]);
    expect(result.slots[0]?.execOwnerReleased).toBe(true);
    expect(work.cancelled).toEqual([S1]);
    expect(sessions.released).toEqual([S1]);
    expect(await registry.getAssignment(key)).toMatchObject({
      ...BINDING,
      state: "ready",
      execOwner: null,
    });
  });

  test("generic allocation stays excluded after release; the slot's next execution may claim", async () => {
    await drain.releaseExecution(S1);

    // Generic exclusion reads these: the device is still held by the slot, not freed.
    expect(await registry.isDeviceAssignedToValidSlot("android", AVD)).toBe(true);
    expect(await registry.snapshotManagedDevices()).toEqual([
      expect.objectContaining({ stableDeviceId: AVD, holder: "slot", slotIndex: 0 }),
    ]);
    expect(await registry.listFreeDevices()).toEqual([]);
    await claim(S2);
  });

  test("unsettled work leaves the slot cleanup_pending, blocks the next claim, then settles", async () => {
    timer.enableAutoAdvance();
    work.endOnCancel = false;
    work.active.set(S1, 1);

    const result = await drain.releaseExecution(S1);

    expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
    expect(result.slots[0]).toMatchObject({ state: "cleanup_pending", execOwnerReleased: true });
    expect(sessions.released).toEqual([S1]);
    expect(await registry.getAssignment(key)).toMatchObject({
      ...BINDING,
      state: "cleanup_pending",
      execOwner: null,
    });
    // The assignment is protected, not freed: the slot's next acquisition waits.
    expect(await registry.isDeviceAssignedToValidSlot("android", AVD)).toBe(true);
    const blocked = await registry.claimExecution(key, BINDING, {
      daemonId: "daemon",
      pid: 1,
      sessionUuid: S2,
    });
    expect(blocked.kind).toBe("slot_not_ready");

    work.active.delete(S1);
    await drain.whenIdle();

    expect(await registry.getAssignment(key)).toMatchObject({ ...BINDING, state: "ready" });
    expect(await drain.releaseExecution(S1)).toMatchObject({
      outcome: "reusable_for_this_slot",
      settlement: "confirmed",
      alreadyReleased: true,
    });
  });

  test("a release stuck past its budget is forced into quarantine and reported cleanup_pending", async () => {
    timer.enableAutoAdvance();
    sessions.hangRelease = true;

    const result = await drain.releaseExecution(S1);

    expect(result).toMatchObject({ outcome: "cleanup_pending", releaseForced: true });
    expect(sessions.forced).toEqual([S1]);
    expect(await registry.getAssignment(key)).toMatchObject({
      ...BINDING,
      state: "cleanup_pending",
      execOwner: null,
    });

    sessions.cleanupInProgress.delete(DEVICE);
    await drain.whenIdle();
    expect(await registry.getAssignment(key)).toMatchObject({ ...BINDING, state: "ready" });
  });

  test("work that never settles stays cleanup_pending past the watcher cap", async () => {
    drain = new ManagedExecutionRelease({
      registry: async () => registry,
      work,
      sessions,
      timer,
      settlementCapMs: 1_000,
    });
    timer.enableAutoAdvance();
    work.endOnCancel = false;
    work.active.set(S1, 1);

    await drain.releaseExecution(S1);
    await drain.whenIdle();

    expect(await registry.getAssignment(key)).toMatchObject({ state: "cleanup_pending" });
  });

  test("repeated and concurrent releases converge without releasing twice", async () => {
    const [first, second] = await Promise.all([
      drain.releaseExecution(S1),
      drain.releaseExecution(S1),
    ]);
    expect(second).toBe(first);
    const again = await drain.releaseExecution(S1);

    expect(sessions.released).toEqual([S1]);
    expect(again).toMatchObject({
      outcome: "reusable_for_this_slot",
      alreadyReleased: true,
      cancellationRequested: 0,
    });
    expect(again.slots).toEqual([
      expect.objectContaining({ stableDeviceId: AVD, state: "ready", execOwnerReleased: false }),
    ]);
  });

  test("a late release of S1 never releases the slot's fresh execution S2", async () => {
    await drain.releaseExecution(S1);
    await claim(S2);

    await drain.releaseExecution(S1);

    expect(sessions.live.has(S2)).toBe(true);
    expect(await registry.getAssignment(key)).toMatchObject({
      execOwner: expect.objectContaining({ sessionUuid: S2 }),
    });
  });

  test("an unknown session with no slot is reported released", async () => {
    expect(await drain.releaseExecution("never-issued")).toMatchObject({
      outcome: "reusable_for_this_slot",
      alreadyReleased: true,
      slots: [],
    });
    expect(sessions.released).toEqual([]);
  });

  describe("releases that did not come through releaseExecution", () => {
    test("heartbeat loss / idle release of a managed session keeps the assignment", async () => {
      sessions.live.delete(S1);
      drain.onSessionReleased({
        sessionId: S1,
        deviceId: DEVICE,
        livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      });
      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({
        ...BINDING,
        state: "ready",
        execOwner: null,
      });
      expect(await registry.isDeviceAssignedToValidSlot("android", AVD)).toBe(true);
    });

    test("work still running at that release keeps the slot cleanup_pending until it settles", async () => {
      timer.enableAutoAdvance();
      work.active.set(S1, 1);
      sessions.live.delete(S1);
      drain.onSessionReleased({
        sessionId: S1,
        deviceId: DEVICE,
        livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      });
      await Promise.resolve();
      await timer.sleep(10);
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "cleanup_pending",
        execOwner: null,
      });

      work.active.delete(S1);
      await drain.whenIdle();
      expect(await registry.getAssignment(key)).toMatchObject({ ...BINDING, state: "ready" });
    });

    test("non-managed sessions and terminal upgrades are ignored", async () => {
      drain.onSessionReleased({ sessionId: S1, deviceId: DEVICE });
      drain.onSessionReleased(
        { sessionId: S1, deviceId: DEVICE, livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY },
        { upgradeOnly: true },
      );
      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: expect.objectContaining({ sessionUuid: S1 }),
      });
    });
  });
});

describe("managed execution release wiring", () => {
  test("a managed session's release snapshot carries the marker the listener keys on", async () => {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    try {
      const policies: Array<string | undefined> = [];
      manager.onSessionRelease((_id, _device, _reason, snapshot) => {
        policies.push(snapshot.livenessPolicy);
      });
      await manager.createSession(S1, DEVICE, "android");
      await manager.adoptManagedExecutionLivenessPolicy(S1);
      await manager.createSession(S2, "emulator-5556", "android");

      await manager.releaseSession(S1);
      await manager.releaseSession(S2);

      expect(policies).toEqual([MANAGED_EXECUTION_LIVENESS_POLICY, undefined]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("daemon/releaseExecution validates its params and needs the drain", async () => {
    const manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    const request = (params: Record<string, unknown>) =>
      handleDaemonRequest(
        { id: "r", type: "daemon_request", method: DAEMON_RELEASE_EXECUTION_METHOD, params },
        state,
      );

    expect(await request({})).toMatchObject({ success: false });
    expect(await request({ sessionId: S1 })).toMatchObject({
      success: false,
      error: expect.stringContaining("not available"),
    });
    manager.stopCleanupTimer();
  });
});
