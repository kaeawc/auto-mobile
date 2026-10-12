import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../../src/daemon/daemon";
import { DaemonState } from "../../../src/daemon/daemonState";
import { SessionManager, type SessionDeviceAssigner } from "../../../src/daemon/sessionManager";
import { ManagedExecutionReowner } from "../../../src/daemon/managedSlots/managedExecutionReowner";
import { ManagedSlotOwnershipUnconfirmedError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import type { SlotAssignmentRecord } from "../../../src/daemon/managedSlots/slotRegistry";
import type { ManagedExecutionReownRegistry } from "../../../src/daemon/managedSlots/managedExecutionReowner";
import { DeviceSessionManager } from "../../../src/devices/DeviceSessionManager";
import { IosCtrlProxyBuilder } from "../../../src/ctrlProxy/IosCtrlProxyBuilder";
import { resetDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { executionTracker } from "../../../src/server/executionTracker";
import { logger } from "../../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceSessionRepository } from "../../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const ID = "recovered-managed";
const DEVICE = "ios-held";

describe("managed execution recovery is gated before publication", () => {
  const managers: SessionManager[] = [];
  const reowners: ManagedExecutionReowner[] = [];
  const restores: Array<() => void> = [];
  const trackerClock = Reflect.get(executionTracker, "sessionClockOffsetProvider");
  const trackerResolver = Reflect.get(executionTracker, "autolockSessionResolver");

  afterEach(async () => {
    for (const reowner of reowners.splice(0)) {
      reowner.close();
      await reowner.whenIdle();
    }
    for (const manager of managers.splice(0)) {
      manager.stopCleanupTimer();
    }
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    DaemonState.getInstance().reset();
    expect(DaemonState.getInstance().getManagedExecutionReowner()).toBeUndefined();
    expect(executionTracker.getActiveExecutionCount()).toBe(0);
    Reflect.set(executionTracker, "sessionClockOffsetProvider", trackerClock);
    Reflect.set(executionTracker, "autolockSessionResolver", trackerResolver);
    resetDbWriteBarrier();
  });

  function manager(timer: FakeTimer, persistence: FakeDeviceSessionPersistence) {
    const sessions = new SessionManager(timer, persistence);
    sessions.stopCleanupTimer();
    managers.push(sessions);
    return sessions;
  }

  test("ordinary creation starts persistence in the calling turn", async () => {
    const sessions = manager(new FakeTimer(), new FakeDeviceSessionPersistence());
    const original = Reflect.get(sessions, "persistAndPublishSession");
    let started = false;
    Reflect.set(sessions, "persistAndPublishSession", (...args: unknown[]) => {
      started = true;
      return Reflect.apply(original, sessions, args);
    });
    const creation = sessions.createSession("ordinary", "fake-device", "android");
    expect(started).toBe(true);
    await creation;
  });

  function assigner(sessions: SessionManager): SessionDeviceAssigner {
    return {
      async assignDeviceToSession(id, platform, target) {
        return (
          await sessions.createSession(
            id,
            DEVICE,
            platform ?? "ios",
            target?.liveness?.sessionTimeoutMs,
            target?.liveness?.heartbeatTimeoutMs,
            target?.stableDeviceId,
            target?.liveness,
            target?.initialOwnership,
          )
        ).assignedDevice;
      },
    };
  }

  async function persisted(managed = true) {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    const before = manager(timer, persistence);
    await before.createSession(ID, DEVICE, "ios");
    if (managed) {
      await before.claimLivenessOwnership(ID, "proxy-token");
      await before.adoptManagedExecutionLivenessPolicy(ID);
    }
    await persistence.markReleased(ID, "expired", timer.now(), "daemon-restart");
    return { timer, persistence, sessions: manager(timer, persistence) };
  }

  test.each(["startup", "on-demand"] as const)(
    "%s recovery invokes the hook before the session is live and gives its publication promise",
    async (path) => {
      const { sessions, timer } = await persisted();
      const gate = Promise.withResolvers<void>();
      let called = false;
      let published = false;
      const reowner = new ManagedExecutionReowner({
        registry: async () => {
          await gate.promise;
          return {
            findExecutionAssignments: async () => [],
            claimExecution: async () => {
              throw new Error("must not claim");
            },
          };
        },
        owner: () => ({ daemonId: "test", pid: 1 }),
        timer,
        isSessionHeld: (id) => sessions.isLiveManagedExecutionSession(id),
      });
      reowners.push(reowner);
      sessions.setManagedExecutionRecoveryListener((id, recovered) => {
        called = true;
        expect(sessions.getSession(id)).toBeNull();
        reowner.noteRecovering(id, recovered);
        expect(reowner.automationRefusal(id)).toBeInstanceOf(ManagedSlotOwnershipUnconfirmedError);
        void recovered.then(() => {
          published = sessions.getSession(id) !== null;
        });
      });
      if (path === "startup") {
        await sessions.rehydratePersistedSessions(assigner(sessions));
      } else {
        await sessions.getOrCreateSession(ID, assigner(sessions), "ios", undefined, true);
      }
      expect(called).toBe(true);
      expect(published).toBe(true);
      expect(reowner.automationRefusal(ID)).toBeInstanceOf(ManagedSlotOwnershipUnconfirmedError);
      gate.resolve();
      await reowner.whenIdle();
    },
  );

  test("a fresh managed acquisition and a recovered heartbeat session never invoke the hook", async () => {
    const { sessions, persistence } = await persisted(false);
    const calls: string[] = [];
    sessions.setManagedExecutionRecoveryListener((id) => {
      calls.push(id);
    });
    await sessions.getOrCreateSession(ID, assigner(sessions), "ios", undefined, true);
    await sessions.createSession("fresh", "fresh-ios", "ios");
    await sessions.claimLivenessOwnership("fresh", "fresh-token");
    await sessions.adoptManagedExecutionLivenessPolicy("fresh");
    expect(calls).toEqual([]);
    expect((await persistence.getSession?.("fresh"))?.liveness_policy).toBe("managed-execution");
  });

  test("the creation promise rejects after rollback and drops the unpublished gate", async () => {
    const { sessions, persistence, timer } = await persisted();
    let opened = false;
    const reowner = new ManagedExecutionReowner({
      registry: async () => {
        opened = true;
        throw new Error("must not open");
      },
      owner: () => ({ daemonId: "test", pid: 1 }),
      timer,
      isSessionHeld: (id) => sessions.isLiveManagedExecutionSession(id),
    });
    reowners.push(reowner);
    sessions.setManagedExecutionRecoveryListener((id, recovered) =>
      reowner.noteRecovering(id, recovered),
    );
    persistence.failure = "create";
    await expect(
      sessions.getOrCreateSession(ID, assigner(sessions), "ios", undefined, true),
    ).rejects.toThrow("persist create failed");
    expect(sessions.getSession(ID)).toBeNull();
    expect(reowner.automationRefusal(ID)).toBeUndefined();
    expect(opened).toBe(false);
  });

  test("a throwing recovery listener is warned and cannot roll back creation", async () => {
    const { sessions } = await persisted();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(() => warn.mockRestore());
    sessions.setManagedExecutionRecoveryListener(() => {
      throw new Error("listener failure");
    });
    await sessions.getOrCreateSession(ID, assigner(sessions), "ios", undefined, true);
    expect(sessions.isLiveManagedExecutionSession(ID)).toBe(true);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes("Managed recovery hook failed")),
    ).toBe(true);
  });

  test("another row failing rehydration cannot skip the managed row's gate", async () => {
    const { sessions, persistence, timer } = await persisted();
    const before = manager(timer, persistence);
    await before.createSession("broken-row", "other-ios", "ios");
    await persistence.markReleased("broken-row", "expired", timer.now(), "daemon-restart");
    const wait = Promise.withResolvers<void>();
    const reowner = new ManagedExecutionReowner({
      registry: async () => {
        await wait.promise;
        return {
          findExecutionAssignments: async () => [],
          claimExecution: async () => {
            throw new Error("must not claim");
          },
        };
      },
      owner: () => ({ daemonId: "test", pid: 1 }),
      timer,
      isSessionHeld: (id) => sessions.isLiveManagedExecutionSession(id),
    });
    reowners.push(reowner);
    sessions.setManagedExecutionRecoveryListener((id, recovered) =>
      reowner.noteRecovering(id, recovered),
    );
    const normal = assigner(sessions);
    await sessions.rehydratePersistedSessions({
      async assignDeviceToSession(id, platform, target) {
        if (id === "broken-row") {
          throw new Error("another row fails");
        }
        return normal.assignDeviceToSession(id, platform, target);
      },
    });
    expect(sessions.isLiveManagedExecutionSession(ID)).toBe(true);
    expect(reowner.automationRefusal(ID)).toBeInstanceOf(ManagedSlotOwnershipUnconfirmedError);
    wait.resolve();
    await reowner.whenIdle();
  });

  test("daemon installs a lazy recovery listener without ingress or a startup batch", async () => {
    const { timer, sessions } = await persisted();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
      new FakeIdGenerator(),
    );
    managers.push(daemon.getSessionManager());
    // Replace only the session persistence boundary; keep the real constructor's recovery listener.
    const installed = Reflect.get(daemon.getSessionManager(), "managedExecutionRecoveryListener");
    expect(installed).toBeFunction();
    Reflect.set(daemon, "sessionManager", sessions);
    sessions.setManagedExecutionRecoveryListener(installed);
    const registryWait = Promise.withResolvers<ManagedExecutionReownRegistry>();
    Reflect.set(daemon, "managedSlotRegistry", registryWait.promise);
    const reowner = DaemonState.getInstance().getManagedExecutionReowner()!;
    reowners.push(reowner);
    await sessions.getOrCreateSession(ID, assigner(sessions), "ios", undefined, true);
    expect(reowner.automationRefusal(ID)).toBeInstanceOf(ManagedSlotOwnershipUnconfirmedError);
    registryWait.resolve({
      findExecutionAssignments: async () => [],
      claimExecution: async () => {
        throw new Error("must not claim");
      },
    });
    await drainMicrotasks(80);
    await reowner.whenIdle();
  });

  test("daemon loss uses the typed cancellation funnel and terminally releases without device writes", async () => {
    const { timer, sessions } = await persisted();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
      new FakeIdGenerator(),
    );
    const original = daemon.getSessionManager();
    managers.push(original);
    sessions.setManagedExecutionRecoveryListener(
      Reflect.get(original, "managedExecutionRecoveryListener"),
    );
    sessions.setReleaseDeviceHold(Reflect.get(original, "releaseDeviceHold"));
    Reflect.set(daemon, "sessionManager", sessions);
    const registryWait = Promise.withResolvers<ManagedExecutionReownRegistry>();
    Reflect.set(daemon, "managedSlotRegistry", registryWait.promise);
    const reowner = DaemonState.getInstance().getManagedExecutionReowner()!;
    reowners.push(reowner);
    const originalRelease = Reflect.get(daemon, "cancelAndReleaseSession");
    const calls: unknown[][] = [];
    Reflect.set(daemon, "cancelAndReleaseSession", (...args: unknown[]) => {
      calls.push(args);
      return Reflect.apply(originalRelease, daemon, args);
    });
    const poolReturn = spyOn(daemon.getDevicePool(), "releaseDevice").mockImplementation(
      async () => {},
    );
    restores.push(() => poolReturn.mockRestore());
    await sessions.getOrCreateSession(ID, assigner(sessions), "ios", undefined, true);
    registryWait.resolve({
      findExecutionAssignments: async () => [],
      claimExecution: async () => {
        throw new Error("must not claim");
      },
    });
    await drainMicrotasks(100);
    await reowner.whenIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("managed-slot-ownership-lost");
    expect(calls[0][5]).toEqual({ cutCallsLearnRelease: true });
    expect(sessions.hasSession(ID)).toBe(false);
    expect(sessions.getTerminalReleaseSnapshot(ID)?.releaseReason).toBe(
      "managed-slot-ownership-lost",
    );
    expect(sessions.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
  });

  test.each(["confirmed", "lost", "released", "moved", "shutdown"] as const)(
    "daemon %s ownership warms only a confirmed device still held here",
    async (outcome) => {
      const { timer, sessions } = await persisted();
      const daemon = new Daemon(
        {},
        new FakeInstalledAppsRepository(),
        timer,
        new FakeDeviceSessionRepository(),
        new FakeIdGenerator(),
      );
      managers.push(daemon.getSessionManager());
      const installed = Reflect.get(daemon.getSessionManager(), "managedExecutionRecoveryListener");
      Reflect.set(daemon, "sessionManager", sessions);
      sessions.setManagedExecutionRecoveryListener(installed);
      const warm: string[] = [];
      const verify = spyOn(
        DeviceSessionManager.getInstance(),
        "verifyIosDevice",
      ).mockImplementation(async (id) => {
        warm.push(id);
      });
      const prefetch = spyOn(IosCtrlProxyBuilder, "pendingPrefetch").mockReturnValue(null);
      restores.push(
        () => verify.mockRestore(),
        () => prefetch.mockRestore(),
      );
      const lookup =
        Promise.withResolvers<
          Awaited<ReturnType<ManagedExecutionReownRegistry["findExecutionAssignments"]>>
        >();
      Reflect.set(
        daemon,
        "managedSlotRegistry",
        Promise.resolve({
          findExecutionAssignments: () => lookup.promise,
          claimExecution: async () => {
            throw new Error("already owned");
          },
        }),
      );
      const reowner = DaemonState.getInstance().getManagedExecutionReowner()!;
      reowners.push(reowner);
      await sessions.getOrCreateSession(ID, assigner(sessions), "ios", undefined, true);
      const devices = spyOn(daemon.getDevicePool(), "getAllDevices").mockReturnValue([
        {
          id: DEVICE,
          name: DEVICE,
          platform: "ios",
          sessionId: ID,
          status: "busy",
          lastUsedAt: timer.now(),
          assignmentCount: 1,
          errorCount: 0,
        },
      ]);
      restores.push(() => devices.mockRestore());
      await Reflect.get(daemon, "initializeIosServices").call(daemon);
      expect(warm).toEqual([]);
      if (outcome === "released") {
        Reflect.get(sessions, "sessions").delete(ID);
      }
      if (outcome === "moved") {
        sessions.getSession(ID)!.assignedDevice = "other-ios";
      }
      if (outcome === "shutdown") {
        Reflect.set(daemon, "shutdownInProgress", true);
      }
      const owner = Reflect.get(daemon, "managedSlotJournalOwner").call(daemon);
      const assignment: SlotAssignmentRecord = {
        scopeKey: "scope",
        slotIndex: 0,
        role: "app",
        platform: "ios",
        generation: 1,
        stableDeviceId: DEVICE,
        deviceName: DEVICE,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
        execOwner: { ...owner, sessionUuid: ID },
        settler: null,
        updatedAtMs: timer.now(),
      };
      lookup.resolve(outcome === "lost" ? [] : [assignment]);
      await drainMicrotasks(80);
      await reowner.whenIdle();
      expect(warm).toEqual(outcome === "confirmed" ? [DEVICE] : []);
    },
  );
});
