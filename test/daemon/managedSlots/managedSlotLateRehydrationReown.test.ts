import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ManagedExecutionReowner } from "../../../src/daemon/managedSlots/managedExecutionReowner";
import {
  type SlotExecOwnerLiveness,
  type SlotKey,
  type SlotProcessIdentity,
  type SlotRegistry,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { openSqliteSlotRegistry } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { SessionManager, type SessionDeviceAssigner } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";

// #11275: a managed execution's session survives a daemon restart (rehydrated, then re-bound by
// its proxy), but its slot still names the previous daemon's PID. The restarted daemon re-owns the
// slot for the same session, so the slot never reads as ownerless while the execution is live.

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "managed-proxy-token";
const BEFORE: SlotProcessIdentity = { daemonId: "before", pid: 4101, processGenerationToken: "b" };
const AFTER: SlotProcessIdentity = { daemonId: "after", pid: 4102, processGenerationToken: "a" };

describe("managed execution across a daemon restart", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let livePids: Set<number>;
  /** The registry's owner liveness; the restarted daemon swaps in its own. */
  let ownerLiveness: SlotExecOwnerLiveness;
  let registry: SlotRegistry;
  let managers: SessionManager[];
  let key: SlotKey;

  function sessionManager(): SessionManager {
    const manager = new SessionManager(timer, persistence);
    managers.push(manager);
    return manager;
  }

  function assigner(manager: SessionManager): SessionDeviceAssigner {
    return {
      async assignDeviceToSession(id, _platform, target): Promise<string> {
        const session = await manager.createSession(
          id,
          "emulator-5554",
          "android",
          target?.liveness?.sessionTimeoutMs,
          target?.liveness?.heartbeatTimeoutMs,
          target?.stableDeviceId,
          target?.liveness,
          target?.initialOwnership,
        );
        return session.assignedDevice;
      },
    };
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    persistence = new FakeDeviceSessionPersistence();
    livePids = new Set([BEFORE.pid]);
    ownerLiveness = (owner) => livePids.has(owner.pid);
    managers = [];
    registry = await openSqliteSlotRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: (owner) => ownerLiveness(owner),
    });
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "runner",
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
        stableDeviceId: "Pixel_8_API_35",
        deviceName: "Pixel_8_API_35",
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
      },
    );
  });

  afterEach(async () => {
    for (const manager of managers) {
      manager.stopCleanupTimer();
    }
    await registry.close();
  });

  function reowner(): ManagedExecutionReowner {
    return new ManagedExecutionReowner({ registry: async () => registry, owner: () => AFTER });
  }

  async function duplicateClaim() {
    const assignment = (await registry.getAssignment(key))!;
    return registry.claimExecution(
      key,
      { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
      { ...AFTER, sessionUuid: "reserve-duplicate-proxy" },
    );
  }

  test("a managed execution rehydrated after the startup deadline is re-owned like the startup batch", async () => {
    const before = sessionManager();
    await before.createSession(
      SESSION,
      "emulator-5554",
      "android",
      undefined,
      undefined,
      "Pixel_8_API_35",
    );
    await before.claimLivenessOwnership(SESSION, TOKEN);
    await before.adoptManagedExecutionLivenessPolicy(SESSION);
    const assignment = (await registry.getAssignment(key))!;
    expect(
      (
        await registry.claimExecution(
          key,
          { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
          { ...BEFORE, sessionUuid: SESSION },
        )
      ).kind,
    ).toBe("claimed");
    before.stopCleanupTimer();
    await persistence.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    livePids.delete(BEFORE.pid);
    livePids.add(AFTER.pid);

    // The restarted daemon's device assignment is slow (emulator still settling): the row
    // finishes rehydrating after the 15 s startup deadline.
    const after = sessionManager();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    // daemon.ts wires the same hook: late rows re-own only live managed executions.
    after.setLateRehydrationListener((ids) =>
      reowner().reown(ids.filter((id) => after.isLiveManagedExecutionSession(id))),
    );
    const fast = assigner(after);
    const slow: SessionDeviceAssigner = {
      async assignDeviceToSession(id, platform, target) {
        await gate;
        return fast.assignDeviceToSession(id, platform, target);
      },
    };
    const summaryPromise = after.rehydratePersistedSessions(slow, { deadlineMs: 1_000 });
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    timer.advanceTime(1_000);
    const summary = await summaryPromise;
    // daemon.ts startup: re-own exactly what the startup batch reports.
    await reowner().reown(
      summary.rehydrated.filter((id) => after.isLiveManagedExecutionSession(id)),
    );

    openGate();
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
    }
    expect(after.isLiveManagedExecutionSession(SESSION)).toBe(true);

    // The execution is live in the restarted daemon, so its slot must not be claimable by a peer
    // that judges the owner by PID alone.
    expect(await duplicateClaim()).toMatchObject({ kind: "slot_in_use" });
  });
});
