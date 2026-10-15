import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ManagedExecutionReowner } from "../../../helpers/deferredProvisioningFixtures";
import {
  BINDING_ABANDONED_SCOPE_THRESHOLD_MS,
  type BindingExecOwnerLiveness,
  type BindingKey,
  type BindingProcessIdentity,
  type BindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { withLiveExecutionSessions } from "../../../../src/daemon/sessionBroker/registry/ownerLiveness";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { SessionManager, type SessionDeviceAssigner } from "../../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../../fakes/FakeTimer";

// #11275: a managed execution's session survives a daemon restart (rehydrated, then re-bound by
// its proxy), but its binding still names the previous daemon's PID. The restarted daemon re-owns the
// binding for the same session, so the binding never reads as ownerless while the execution is live.

const SESSION = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "managed-proxy-token";
const BEFORE: BindingProcessIdentity = {
  daemonId: "before",
  pid: 4101,
  processGenerationToken: "b",
};
const AFTER: BindingProcessIdentity = { daemonId: "after", pid: 4102, processGenerationToken: "a" };

const reowners: ManagedExecutionReowner[] = [];
afterEach(async () => {
  for (const reowner of reowners.splice(0)) {
    reowner.close();
    await reowner.whenIdle();
  }
});

describe("managed execution across a daemon restart", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let livePids: Set<number>;
  /** The registry's owner liveness; the restarted daemon swaps in its own. */
  let ownerLiveness: BindingExecOwnerLiveness;
  let registry: BindingRegistry;
  let managers: SessionManager[];
  let key: BindingKey;

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
    registry = await openSqliteBindingRegistry({
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
    key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, { role: "primary", platform: "android", requestedSpec: {} });
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

  /** The first daemon hands the binding's session to its proxy, then exits; the second rehydrates. */
  async function restartWithLiveExecution(): Promise<{
    manager: SessionManager;
    rehydrated: string[];
  }> {
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
    const claimed = await registry.claimExecution(
      key,
      { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
      { ...BEFORE, sessionUuid: SESSION },
    );
    expect(claimed.kind).toBe("claimed");

    before.stopCleanupTimer();
    await persistence.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    livePids.delete(BEFORE.pid);
    livePids.add(AFTER.pid);

    const after = sessionManager();
    const summary = await after.rehydratePersistedSessions(assigner(after));
    return { manager: after, rehydrated: summary.rehydrated };
  }

  function reowner(): ManagedExecutionReowner {
    const instance = new ManagedExecutionReowner({
      registry: async () => registry,
      owner: () => AFTER,
    });
    reowners.push(instance);
    return instance;
  }

  async function duplicateClaim() {
    const assignment = (await registry.getAssignment(key))!;
    return registry.claimExecution(
      key,
      { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
      { ...AFTER, sessionUuid: "reserve-duplicate-proxy" },
    );
  }

  test("the rehydrated session is a live managed execution of the restarted daemon", async () => {
    const { manager, rehydrated } = await restartWithLiveExecution();

    expect(rehydrated).toEqual([SESSION]);
    expect(manager.isLiveManagedExecutionSession(SESSION)).toBe(true);
    expect(manager.isLiveManagedExecutionSession("never-issued")).toBe(false);
  });

  test("without re-owning, the dead previous daemon leaves the live execution claimable", async () => {
    await restartWithLiveExecution();

    // The hazard #11275 fixes: the registry alone sees only the dead PID.
    expect((await duplicateClaim()).kind).toBe("claimed");
  });

  test("re-owning the rehydrated execution refuses a duplicate with binding_in_use and blocks abandonment", async () => {
    const { manager, rehydrated } = await restartWithLiveExecution();

    const executions = rehydrated.filter((id) => manager.isLiveManagedExecutionSession(id));
    const reowned = await reowner().reown(executions);

    expect(reowned.map((binding) => binding.execOwner)).toEqual([
      { ...AFTER, sessionUuid: SESSION },
    ]);
    expect(await duplicateClaim()).toMatchObject({
      kind: "binding_in_use",
      owner: { sessionUuid: SESSION },
    });
    timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS + 60_000);
    expect(await registry.findAbandonedScopes()).toEqual([]);
    expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
      kind: "not_abandoned",
      reason: "live_owner",
    });
  });

  test("before any re-own, the restarted daemon's liveness keeps the live execution's binding in use", async () => {
    // The scope's last acquisition is already past the abandonment threshold when the restart
    // lands, and the session is live (rehydrated, awaiting its proxy's re-bind).
    timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS + 60_000);
    const { manager } = await restartWithLiveExecution();
    // The daemon's registry liveness: the recorded process, or a session it holds live (#11275).
    ownerLiveness = withLiveExecutionSessions((owner) => livePids.has(owner.pid), manager);

    expect(await duplicateClaim()).toMatchObject({
      kind: "binding_in_use",
      owner: { sessionUuid: SESSION, pid: BEFORE.pid },
    });
    expect(await registry.findAbandonedScopes()).toEqual([]);
    expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({
      kind: "not_abandoned",
      reason: "live_owner",
    });

    // Once the session is gone, the dead previous daemon no longer pins the binding.
    await manager.releaseSession(SESSION);
    expect(await registry.findAbandonedScopes()).toHaveLength(1);
  });
});

describe("ManagedExecutionReowner", () => {
  test("never opens a registry the host does not have", async () => {
    let opened = false;
    const reowner = new ManagedExecutionReowner({
      registry: async () => {
        opened = true;
        throw new Error("must not open");
      },
      registryExists: () => false,
      owner: () => AFTER,
    });

    reowners.push(reowner);
    expect(await reowner.reown([SESSION])).toEqual([]);
    expect(opened).toBe(false);
  });

  test("a registry failure is logged and reported as nothing re-owned, never thrown", async () => {
    const reowner = new ManagedExecutionReowner({
      registry: async () => {
        throw new Error("registry locked");
      },
      owner: () => AFTER,
    });

    reowners.push(reowner);
    expect(await reowner.reown([SESSION])).toEqual([]);
  });
});
