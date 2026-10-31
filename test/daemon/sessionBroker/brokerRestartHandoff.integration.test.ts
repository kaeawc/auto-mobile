import { InMemoryMutationRecordingGaps } from "../../../src/daemon/sessionBroker/mutations/recordingGaps";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import {
  SessionRequestOwnerMismatchError,
  SESSION_BROKER_RETRY_AFTER_MS,
} from "../../../src/daemon/sessionBroker/SessionRequestOwnerMismatchError";
import { SessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import { sessionDisposition } from "../../../src/daemon/sessionBroker/sessionDisposition";
import { ManagedExecutionReowner } from "../../../src/daemon/sessionBroker/provisioning/executionReowner";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "../../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import { SessionManager, type SessionDeviceAssigner } from "../../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../../src/db/deviceSessionRepository";
import type { Database } from "../../../src/db/types";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { assertSessionBrokerToolCall } from "../../../src/server/sessionBrokerToolGate";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { createTestDatabase } from "../../db/testDbHelper";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";

/**
 * Provider restart handoff (#12451), device-free: the real broker, its SQLite store and binding
 * registry, the real session manager and device-session repository, and the real execution
 * reowner. Only native device operations are fake. Each "daemon" is one process identity over the
 * same durable state, started the way the daemon starts: rehydrate, re-own, then broker recovery.
 */
const FIRST: BindingProcessIdentity = {
  daemonId: "daemon-a",
  pid: 101,
  processGenerationToken: "a",
};
const SECOND: BindingProcessIdentity = {
  daemonId: "daemon-b",
  pid: 202,
  processGenerationToken: "b",
};
const TOKEN = "proxy-owner-token";
const REQUEST = "restart-request";

function config(): SessionConfig {
  return {
    contractVersion: 1,
    requestId: REQUEST,
    device: {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

interface DaemonUnderTest {
  broker: SessionBroker;
  service: SessionBrokerService;
  sessions: SessionManager;
}

describe("session broker provider restart handoff", () => {
  let db: Kysely<Database> | undefined;
  let registry: SqliteBindingRegistry | undefined;
  const managers: SessionManager[] = [];
  const reowners: ManagedExecutionReowner[] = [];

  beforeAll(async () => {
    // Warm SQLite/migration setup outside the per-test budget.
    await (await openSqliteBindingRegistry({ dbPath: ":memory:" })).close();
    await (await createTestDatabase()).destroy();
  });

  afterEach(async () => {
    reowners.splice(0).forEach((reowner) => reowner.close());
    managers.splice(0).forEach((manager) => manager.stopCleanupTimer());
    await registry?.close();
    registry = undefined;
    await db?.destroy();
    db = undefined;
  });

  async function world() {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    db = await createTestDatabase();
    const repository = new DeviceSessionRepository(db, timer);
    const live = new Set<string>([FIRST.daemonId]);
    const opened = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: (owner) => live.has(owner.daemonId),
    });
    registry = opened;
    const scope = await opened.ensureScope({
      managedHostScope: "restart-host",
      runnerNamespace: "restart-broker",
      runnerIncarnation: "persistent",
    });
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    const { scopeKey } = scope.scope;
    const store = opened.sessionBrokerStore(scopeKey, new CountingIdGenerator("res"));
    // Native devices outlive any one daemon process.
    const devices = new FakeNativePort(opened, new CountingIdGenerator("session"), FIRST);

    function daemon(owner: BindingProcessIdentity): DaemonUnderTest {
      const sessions = new SessionManager(timer, repository);
      sessions.stopCleanupTimer();
      managers.push(sessions);
      const broker = new SessionBroker({
        store,
        devices,
        owner,
        limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
        catalog: async () => iosCatalog(),
        defaults: () => iosDefaults(),
        // The daemon's production wiring of the disposition seam.
        sessionDisposition: (uuid) =>
          sessionDisposition(uuid, {
            isLive: (id) => sessions.peekSession(id) !== null,
            getSession: (id) => repository.getSession(id),
            timer,
          }),
      });
      const service = new SessionBrokerService(
        broker,
        scopeKey,
        { acquire: () => {}, release: () => {} },
        { timer, mutations: { recordingGaps: new InMemoryMutationRecordingGaps() } },
      );
      return { broker, service, sessions };
    }

    /** Startup order of a restarted daemon: rehydrate, re-own bindings, then broker recovery. */
    async function restart(): Promise<DaemonUnderTest> {
      live.delete(FIRST.daemonId);
      live.add(SECOND.daemonId);
      const next = daemon(SECOND);
      const assigner: SessionDeviceAssigner = {
        async assignDeviceToSession(id, _platform, target) {
          return (
            await next.sessions.createSession(id, target?.deviceId ?? "sim-fake", "ios", {
              timeoutMs: target?.liveness?.sessionTimeoutMs,
              heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
              stableDeviceId: target?.stableDeviceId,
              recoveredLiveness: target?.liveness,
              initialOwnership: target?.initialOwnership,
            })
          ).assignedDevice;
        },
      };
      const rehydration = await next.sessions.rehydratePersistedSessions(assigner);
      const reowner = new ManagedExecutionReowner({
        registry: async () => opened,
        owner: () => SECOND,
        timer,
        isSessionHeld: (id) => next.sessions.isLiveManagedExecutionSession(id),
      });
      reowners.push(reowner);
      await reowner.reown(
        rehydration.rehydrated.filter((id) => next.sessions.isLiveManagedExecutionSession(id)),
        { rehydrated: true },
      );
      await next.broker.recover();
      return next;
    }

    return { timer, repository, store, devices, daemon, restart };
  }

  /** A granted broker session as the daemon registers it for the consumer's proxy. */
  async function grant(first: DaemonUnderTest): Promise<string> {
    const result = await first.broker.prepare(config(), TOKEN);
    expect(result.outcome).toBe("ready");
    const uuid = result.sessionUuid!;
    await first.sessions.createSession(uuid, "sim-fake", "ios");
    await first.sessions.claimLivenessOwnership(uuid, TOKEN);
    await first.sessions.adoptManagedExecutionLivenessPolicy(uuid);
    return uuid;
  }

  function observeGate(next: DaemonUnderTest, uuid: string): Promise<void> {
    return assertSessionBrokerToolCall(
      "observe",
      true,
      { sessionUuid: uuid },
      {
        isSessionBrokerMode: () => true,
        isInitialized: () => true,
        getSessionBrokerService: () => ({ broker: next.broker }),
        getSessionManager: () => next.sessions,
      },
    );
  }

  async function expectNoDestruction(store: SqliteSessionBrokerStore, devices: FakeNativePort) {
    expect(devices.released).toEqual([]);
    expect(devices.destroyed).toEqual([]);
    expect((await store.listResources()).map((resource) => resource.state)).toEqual(["active"]);
  }

  test("graceful stop/start keeps the same ready session and its device", async () => {
    const { store, devices, daemon, restart } = await world();
    const first = daemon(FIRST);
    const uuid = await grant(first);

    // Daemon shutdown order: the managed-execution stage closes the broker service, then the
    // active-session stage releases every session for `daemon-shutdown`.
    await first.service.close();
    await first.sessions.releaseSession(uuid, "daemon-shutdown");
    await expectNoDestruction(store, devices);

    const next = await restart();
    expect(await next.broker.ownedStatus(REQUEST, TOKEN)).toMatchObject({
      outcome: "ready",
      sessionUuid: uuid,
      cleanupPending: false,
    });
    expect(await store.getRequest(REQUEST)).toMatchObject({ state: "active", owner: SECOND });
    await expect(observeGate(next, uuid)).resolves.toBeUndefined();
    await expectNoDestruction(store, devices);
    // Later recovery passes keep it while the session is live.
    await next.broker.recover();
    await expectNoDestruction(store, devices);

    // The consumer's own release still ends it normally.
    expect(await next.broker.release(uuid)).toEqual({ sessionUuid: uuid, outcome: "released" });
    expect(devices.destroyed).toHaveLength(1);
  });

  for (const restartHandoff of [true, false]) {
    for (const operation of ["release", "abandon"] as const) {
      test(`${operation} refuses an unadopted generation without native work (restartHandoff=${restartHandoff})`, async () => {
        const { store, devices, daemon } = await world();
        const first = daemon(FIRST);
        const uuid = await grant(first);
        if (restartHandoff) {
          await first.service.close();
        }
        // The old owner is still live; a successor cannot adopt this request yet.
        const next = daemon(SECOND);
        const receipt = await store.getRequest(REQUEST);
        const resources = await store.listResources();
        for (let attempt = 0; attempt < 2; attempt++) {
          const failure = await (
            operation === "release"
              ? next.broker.release(uuid)
              : next.broker.abandon(REQUEST, TOKEN)
          ).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(SessionRequestOwnerMismatchError);
          expect(failure).toMatchObject({
            code: restartHandoff ? "session_restart_handoff_pending" : "session_owner_mismatch",
            retryable: restartHandoff,
          });
          expect(
            failure instanceof SessionRequestOwnerMismatchError ? failure.retryAfterMs : null,
          ).toBe(restartHandoff ? SESSION_BROKER_RETRY_AFTER_MS : undefined);
          expect(await store.getRequest(REQUEST)).toEqual(receipt);
          expect(await store.listResources()).toEqual(resources);
          await expectNoDestruction(store, devices);
        }
      });
    }
  }

  test("a crashed daemon's session is retired as session_owner_exited, never explicit release", async () => {
    const { timer, repository, store, devices, daemon, restart } = await world();
    const first = daemon(FIRST);
    const uuid = await grant(first);

    // SIGKILL: no shutdown stages run. Startup tags the dead daemon's active rows for recovery.
    await repository.markReleased(uuid, "expired", timer.now(), { reason: "daemon-restart" });
    const next = await restart();
    expect(await next.broker.ownedStatus(REQUEST, TOKEN)).toMatchObject({
      outcome: "failed",
      sessionUuid: uuid,
      cleanupPending: false,
      failure: { code: "session_owner_exited" },
    });
    expect(devices.destroyed).toHaveLength(1);
    expect((await store.listResources()).map((resource) => resource.state)).toEqual(["destroyed"]);
    await expect(observeGate(next, uuid)).rejects.toThrow();
  });
});
