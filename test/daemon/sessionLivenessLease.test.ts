import { beforeEach, describe, expect, spyOn, test, afterEach, mock } from "bun:test";
import { DeviceSessionNotActiveError } from "../../src/db/deviceSessionRepository";
import type { LivenessHoldState, LivenessOwnerView } from "../../src/daemon/livenessClaimDecision";
import {
  SessionLivenessController,
  rebaseIdleDeadlineOnLastActivity,
  widenIdleDeadlineFromLastActivity,
  type SessionLivenessPort,
} from "../../src/daemon/sessionLivenessLease";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../src/models/managedExecutionLiveness";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

afterEach(() => {
  mock.restore();
});

/** Enough turns to settle a barrier-tracked write behind the claim mutex. */
const DRAIN_TURNS = 10;

const IDLE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 4_000;
const CLI_IDLE_MS = 600_000;

function makeSession(sessionId: string, now: number, overrides: Partial<Session> = {}): Session {
  return {
    sessionId,
    assignedDevice: "emulator-5554",
    platform: "android",
    createdAt: now,
    lastUsedAt: now,
    activityGeneration: 0,
    expiresAt: now + IDLE_MS,
    cacheData: {},
    lastHeartbeat: now,
    sessionTimeoutMs: IDLE_MS,
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_MS,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
    ownership: "owned",
    livenessPolicy: "heartbeat",
    ...overrides,
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A host with a session table, a recorded set of liveness writes and a switchable store. */
class FakeLivenessPort implements SessionLivenessPort {
  readonly sessions = new Map<string, Session>();
  readonly barrier = new FakeDbWriteBarrier();
  readonly ownershipWrites: Array<[string, string | null]> = [];
  readonly replacedOwnership: Array<[string, string | null]> = [];
  readonly activityWrites: Session[] = [];
  readonly lookups: string[] = [];
  readonly ownerViewCalls: string[] = [];
  readonly holds = new Map<string, LivenessHoldState>();
  endedBases = new Set<string>();
  unissued = new Set<Session>();
  admitted = true;
  ownershipWrite: () => Promise<void> = async () => {};
  replaceWrite: () => Promise<void> = async () => {};
  activityWrite: () => Promise<void> = async () => {};

  constructor(private readonly timer: FakeTimer) {}

  getSession(sessionId: string): Session | null {
    this.lookups.push(`get:${sessionId}`);
    return this.sessions.get(sessionId) ?? null;
  }

  peekSession(sessionId: string): Session | null {
    this.lookups.push(`peek:${sessionId}`);
    return this.sessions.get(sessionId) ?? null;
  }

  unlessBaseEnded(session: Session | null): Session | null {
    return session && this.endedBases.has(session.sessionId) ? null : session;
  }

  isAdmittedForAutomation(session: Session): boolean {
    return this.admitted && this.sessions.get(session.sessionId) === session;
  }

  sessionNow(): number {
    return this.timer.now();
  }

  ownershipSessionUuid(sessionId: string): string {
    const separator = sessionId.indexOf(":");
    return separator < 0 ? sessionId : sessionId.slice(0, separator);
  }

  livenessOwnerView(session: Session): LivenessOwnerView {
    this.ownerViewCalls.push(session.sessionId);
    return {
      ownerToken: session.livenessOwnerToken,
      hold: session.livenessOwnerToken ? (this.holds.get(session.sessionId) ?? "live") : "none",
    };
  }

  hasUnissuedActivity(session: Session): boolean {
    return this.unissued.has(session);
  }

  async recordSessionActivity(session: Session): Promise<void> {
    this.activityWrites.push(session);
    this.unissued.delete(session);
    await this.activityWrite();
  }

  getBarrier(): FakeDbWriteBarrier {
    return this.barrier;
  }

  async recordLivenessOwnership(sessionId: string, ownerToken: string | null): Promise<void> {
    this.ownershipWrites.push([sessionId, ownerToken]);
    await this.ownershipWrite();
  }

  async replaceLivenessOwnership(sessionId: string, ownerToken: string | null): Promise<void> {
    this.replacedOwnership.push([sessionId, ownerToken]);
    await this.replaceWrite();
  }

  defaultHeartbeatTimeoutMs(): number {
    return DEFAULT_HEARTBEAT_MS;
  }
}

describe("SessionLivenessController", () => {
  let timer: FakeTimer;
  let port: FakeLivenessPort;
  let controller: SessionLivenessController;

  const add = (sessionId: string, overrides: Partial<Session> = {}): Session => {
    const session = makeSession(sessionId, timer.now(), overrides);
    port.sessions.set(sessionId, session);
    return session;
  };

  beforeEach(() => {
    timer = new FakeTimer();
    port = new FakeLivenessPort(timer);
    controller = new SessionLivenessController(port);
  });

  describe("recordHeartbeat", () => {
    test("renews the lease and never the tool-activity clocks", () => {
      const session = add("s1", { ownership: "awaiting-owner", awaitingOwnerSince: 5 });
      const { lastUsedAt, expiresAt } = session;
      timer.advanceTime(2_000);

      controller.recordHeartbeat("s1");

      expect(session.lastHeartbeat).toBe(timer.now());
      expect(session.lastOwnerHeartbeat).toBe(timer.now());
      expect(session.hasReceivedHeartbeat).toBe(true);
      expect(session.activityGeneration).toBe(1);
      expect(session.ownership).toBe("owned");
      expect(session.awaitingOwnerSince).toBeUndefined();
      expect(session.lastUsedAt).toBe(lastUsedAt);
      expect(session.expiresAt).toBe(expiresAt);
    });

    test("does not touch the database when every persisted field is already stored", async () => {
      const session = add("s1");
      for (let beat = 0; beat < 5; beat++) {
        timer.advanceTime(2_000);
        controller.recordHeartbeat("s1");
      }
      await drainMicrotasks(DRAIN_TURNS);

      expect(port.activityWrites).toEqual([]);
      expect(port.barrier.trackCalls).toBe(0);
      expect(port.ownershipWrites).toEqual([]);
      expect(session.activityGeneration).toBe(5);
    });

    test("records activity once, through the barrier, when a persisted field is unissued", async () => {
      const session = add("s1");
      port.unissued.add(session);

      controller.recordHeartbeat("s1");
      controller.recordHeartbeat("s1");
      await drainMicrotasks(DRAIN_TURNS);

      expect(port.activityWrites).toEqual([session]);
      expect(port.barrier.trackCalls).toBe(1);
    });

    test("keeps the lease when the activity write fails", async () => {
      const session = add("s1");
      port.unissued.add(session);
      port.activityWrite = async () => {
        throw new Error("disk full");
      };
      timer.advanceTime(2_000);

      controller.recordHeartbeat("s1");
      await drainMicrotasks(DRAIN_TURNS);

      expect(session.lastOwnerHeartbeat).toBe(timer.now());
      expect(session.hasReceivedHeartbeat).toBe(true);
    });

    test("ignores an unknown session, an unadmitted one and a label whose base ended", () => {
      controller.recordHeartbeat("missing");
      const unadmitted = add("s1");
      port.admitted = false;
      controller.recordHeartbeat("s1");
      expect(unadmitted.hasReceivedHeartbeat).toBe(false);

      port.admitted = true;
      add("base:label");
      port.endedBases.add("base:label");
      controller.recordHeartbeat("base:label");
      expect(port.sessions.get("base:label")?.hasReceivedHeartbeat).toBe(false);
    });
  });

  describe("claimLivenessOwnership", () => {
    test("claims an unowned session, stamps the lease and persists the owner", async () => {
      const session = add("s1", { ownership: "awaiting-owner", awaitingOwnerSince: 5 });
      timer.advanceTime(1_000);

      await expect(controller.claimLivenessOwnership("s1", "token-a")).resolves.toBe("claimed");

      expect(session.livenessOwnerToken).toBe("token-a");
      expect(session.lastOwnerHeartbeat).toBe(timer.now());
      expect(session.hasReceivedHeartbeat).toBe(true);
      expect(session.ownership).toBe("owned");
      expect(session.awaitingOwnerSince).toBeUndefined();
      expect(port.ownershipWrites).toEqual([["s1", "token-a"]]);
      expect(session.livenessOwnershipClaims).toEqual(new Set(["token-a"]));
    });

    test("an owner's retried claim writes nothing more", async () => {
      add("s1");
      await controller.claimLivenessOwnership("s1", "token-a");
      await expect(controller.claimLivenessOwnership("s1", "token-a")).resolves.toBe("claimed");
      expect(port.ownershipWrites).toHaveLength(1);
    });

    test("refuses a foreign claim while the owner's lease is live, and a displaced token's retry", async () => {
      const session = add("s1");
      await controller.claimLivenessOwnership("s1", "token-a");

      await expect(controller.claimLivenessOwnership("s1", "token-b")).resolves.toBe("conflict");
      expect(session.livenessOwnerToken).toBe("token-a");

      port.holds.set("s1", "none");
      await expect(controller.claimLivenessOwnership("s1", "token-b")).resolves.toBe("claimed");
      await expect(controller.claimLivenessOwnership("s1", "token-a")).resolves.toBe("superseded");
      expect(session.livenessOwnerToken).toBe("token-b");
    });

    test("judges a label against its base's owner", async () => {
      add("base");
      const label = add("base:label");
      await controller.claimLivenessOwnership("base", "token-a");

      await expect(controller.claimLivenessOwnership("base:label", "token-b")).resolves.toBe(
        "conflict",
      );
      await expect(controller.claimLivenessOwnership("base:label", "token-a")).resolves.toBe(
        "claimed",
      );
      expect(label.livenessOwnerToken).toBe("token-a");
    });

    test("reports not-found for an unknown session and for a replaced one", async () => {
      await expect(controller.claimLivenessOwnership("missing", "token-a")).resolves.toBe(
        "not-found",
      );

      add("s1");
      const gate = deferred();
      const first = controller.claimLivenessOwnership("s1", "token-a");
      port.ownershipWrite = () => gate.promise;
      const second = controller.claimLivenessOwnership("s1", "token-b");
      port.sessions.set("s1", makeSession("s1", timer.now()));
      gate.resolve();
      await first;
      await expect(second).resolves.toBe("not-found");
    });

    test("undoes a claim whose write fails and rethrows", async () => {
      const session = add("s1", { ownership: "awaiting-owner", awaitingOwnerSince: 5 });
      const before = session.lastOwnerHeartbeat;
      port.ownershipWrite = async () => {
        throw new Error("busy");
      };

      await expect(controller.claimLivenessOwnership("s1", "token-a")).rejects.toThrow("busy");

      expect(session.livenessOwnerToken).toBeUndefined();
      expect(session.lastOwnerHeartbeat).toBe(before);
      expect(session.hasReceivedHeartbeat).toBe(false);
      expect(session.ownership).toBe("awaiting-owner");
      expect(session.livenessOwnershipClaims?.has("token-a")).toBe(false);
    });

    test("a write that fails after the session was released reports not-found", async () => {
      add("s1");
      port.ownershipWrite = async () => {
        port.admitted = false;
        throw new Error("no active row");
      };
      await expect(controller.claimLivenessOwnership("s1", "token-a")).resolves.toBe("not-found");
    });

    test("serializes claims on one session and gives each session its own mutex", async () => {
      const session = add("s1");
      const other = add("s2");
      expect(controller.livenessOwnershipClaimMutexFor(session)).toBe(
        controller.livenessOwnershipClaimMutexFor(session),
      );
      expect(controller.livenessOwnershipClaimMutexFor(session)).not.toBe(
        controller.livenessOwnershipClaimMutexFor(other),
      );

      const gate = deferred();
      port.ownershipWrite = () => gate.promise;
      const first = controller.claimLivenessOwnership("s1", "token-a");
      const second = controller.claimLivenessOwnership("s1", "token-b");
      await drainMicrotasks(DRAIN_TURNS);

      // The second claim has not been judged while the first holds the mutex.
      expect(port.ownerViewCalls).toEqual(["s1"]);
      expect(port.ownershipWrites).toEqual([["s1", "token-a"]]);

      gate.resolve();
      await expect(first).resolves.toBe("claimed");
      await expect(second).resolves.toBe("conflict");
      expect(port.ownershipWrites).toHaveLength(1);
    });
  });

  describe("releaseLivenessOwnership", () => {
    test("clears only the owner token and fences older heartbeat rollbacks", async () => {
      const session = add("s1");
      await controller.claimLivenessOwnership("s1", "token-a");
      const generation = session.activityGeneration;

      await expect(controller.releaseLivenessOwnership("s1", "token-a")).resolves.toBe("released");

      expect(session.livenessOwnerToken).toBeUndefined();
      expect(session.activityGeneration).toBe(generation + 1);
      expect(session.livenessOwnershipClaims?.has("token-a")).toBe(true);
      expect(port.ownershipWrites.at(-1)).toEqual(["s1", null]);
    });

    test("answers already-unowned, not-owner and not-found", async () => {
      add("s1");
      await expect(controller.releaseLivenessOwnership("s1", "token-a")).resolves.toBe(
        "already-unowned",
      );
      await controller.claimLivenessOwnership("s1", "token-a");
      await expect(controller.releaseLivenessOwnership("s1", "token-b")).resolves.toBe("not-owner");
      await expect(controller.releaseLivenessOwnership("missing", "token-a")).resolves.toBe(
        "not-found",
      );
    });

    test("restores the owner when the write fails, or reports not-found once released", async () => {
      const session = add("s1", { livenessOwnerToken: "token-a", livenessOwnerBoundAt: 7 });
      port.ownershipWrite = async () => {
        throw new Error("busy");
      };
      await expect(controller.releaseLivenessOwnership("s1", "token-a")).rejects.toThrow("busy");
      expect(session.livenessOwnerToken).toBe("token-a");
      expect(session.livenessOwnerBoundAt).toBe(7);

      port.ownershipWrite = async () => {
        port.admitted = false;
        throw new Error("no active row");
      };
      await expect(controller.releaseLivenessOwnership("s1", "token-a")).resolves.toBe("not-found");
    });
  });

  describe("unowned adoption", () => {
    test("adopts an unowned session and persists the token off the request path", async () => {
      const session = add("s1");
      timer.advanceTime(500);

      expect(controller.claimUnownedLivenessOwnership("s1", "token-a")).toBe(true);
      expect(session.livenessOwnerToken).toBe("token-a");
      expect(session.lastOwnerHeartbeat).toBe(timer.now());
      await drainMicrotasks(DRAIN_TURNS);

      expect(port.replacedOwnership).toEqual([["s1", "token-a"]]);
      expect(controller.hasLivenessOwnership("s1", "token-a")).toBe(true);
      expect(controller.hasLivenessOwnership("s1", "token-b")).toBe(false);
    });

    test("refuses an owned session, one with claim history, and an unknown one", () => {
      add("owned", { livenessOwnerToken: "token-a" });
      add("history", { livenessOwnershipClaims: new Set(["token-a"]) });
      expect(controller.claimUnownedLivenessOwnership("owned", "token-b")).toBe(false);
      expect(controller.claimUnownedLivenessOwnership("history", "token-b")).toBe(false);
      expect(controller.claimUnownedLivenessOwnership("missing", "token-b")).toBe(false);
    });

    test("binding an acquisition identity starts only the claim lease", () => {
      const session = add("s1");
      timer.advanceTime(300);

      expect(controller.bindAcquiredLivenessOwnerToken("s1", "token-a")).toBe(true);

      expect(session.livenessOwnerBoundAt).toBe(timer.now());
      expect(session.lastOwnerHeartbeat).toBeUndefined();
      expect(session.hasReceivedHeartbeat).toBe(false);
      expect(port.lookups).toContain("peek:s1");
    });

    test("a persist that finds no active row is swallowed and the adoption stands", async () => {
      const session = add("s1");
      port.replaceWrite = async () => {
        throw new DeviceSessionNotActiveError("s1");
      };
      expect(controller.claimUnownedLivenessOwnership("s1", "token-a")).toBe(true);
      await drainMicrotasks(DRAIN_TURNS);
      expect(session.livenessOwnerToken).toBe("token-a");
    });

    test("any other persist failure is also contained", async () => {
      const session = add("s1");
      port.replaceWrite = async () => {
        throw new Error("secret-token-a leaked in a driver message");
      };
      expect(controller.claimUnownedLivenessOwnership("s1", "token-a")).toBe(true);
      await drainMicrotasks(DRAIN_TURNS);
      expect(session.livenessOwnerToken).toBe("token-a");
    });
  });

  describe("CLI liveness policy", () => {
    test("adoption snapshots the strict contract, widens the window and anchors it on the last tool call", () => {
      const session = add("s1");
      const { lastUsedAt } = session;
      timer.advanceTime(30_000);

      expect(controller.adoptCliLivenessPolicy("s1", CLI_IDLE_MS)).toBe(true);

      expect(session.livenessPolicy).toBe("cli-idle");
      expect(session.heartbeatTimeoutMs).toBe(CLI_IDLE_MS);
      expect(session.sessionTimeoutMs).toBe(CLI_IDLE_MS);
      expect(session.preCliLiveness).toEqual({
        heartbeatTimeoutMs: DEFAULT_HEARTBEAT_MS,
        heartbeatTimeoutSource: "default",
        sessionTimeoutMs: IDLE_MS,
      });
      expect(session.expiresAt).toBe(lastUsedAt + CLI_IDLE_MS);
      expect(session.lastUsedAt).toBe(lastUsedAt);
      expect(session.lastHeartbeat).toBe(timer.now());
    });

    test("re-adoption keeps the first snapshot and a longer existing window", () => {
      const session = add("s1", { sessionTimeoutMs: 2 * CLI_IDLE_MS, expiresAt: 2 * CLI_IDLE_MS });
      controller.adoptCliLivenessPolicy("s1", CLI_IDLE_MS);
      const snapshot = session.preCliLiveness;
      controller.adoptCliLivenessPolicy("s1", CLI_IDLE_MS);

      expect(session.preCliLiveness).toBe(snapshot);
      expect(session.sessionTimeoutMs).toBe(2 * CLI_IDLE_MS);
      expect(session.expiresAt).toBe(2 * CLI_IDLE_MS);
    });

    test("refuses a managed-execution session and an unknown one", () => {
      const managed = add("managed", { livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY });
      expect(controller.adoptCliLivenessPolicy("managed", CLI_IDLE_MS)).toBe(false);
      expect(managed.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
      expect(controller.adoptCliLivenessPolicy("missing", CLI_IDLE_MS)).toBe(false);
    });

    test("restoring puts the snapshot back and rebases the deadline on the last tool call", () => {
      const session = add("s1");
      const { lastUsedAt } = session;
      controller.adoptCliLivenessPolicy("s1", CLI_IDLE_MS);
      timer.advanceTime(10_000);

      expect(controller.restoreHeartbeatLivenessPolicy("s1")).toBe(true);

      expect(session.livenessPolicy).toBe("heartbeat");
      expect(session.heartbeatTimeoutMs).toBe(DEFAULT_HEARTBEAT_MS);
      expect(session.sessionTimeoutMs).toBe(IDLE_MS);
      expect(session.preCliLiveness).toBeUndefined();
      expect(session.expiresAt).toBe(lastUsedAt + IDLE_MS);
      expect(session.lastHeartbeat).toBe(timer.now());
    });

    test("restoring without a snapshot falls back to the default strict timeout", () => {
      const session = add("s1", {
        livenessPolicy: "cli-idle",
        heartbeatTimeoutMs: CLI_IDLE_MS,
        heartbeatTimeoutSource: "custom",
        sessionTimeoutMs: CLI_IDLE_MS,
        expiresAt: CLI_IDLE_MS,
      });

      expect(controller.restoreHeartbeatLivenessPolicy("s1")).toBe(true);

      expect(session.livenessPolicy).toBe("heartbeat");
      expect(session.heartbeatTimeoutMs).toBe(DEFAULT_HEARTBEAT_MS);
      expect(session.heartbeatTimeoutSource).toBe("default");
      expect(session.sessionTimeoutMs).toBe(CLI_IDLE_MS);
    });

    test("restoring does nothing for a session not on the CLI policy", () => {
      add("s1");
      expect(controller.restoreHeartbeatLivenessPolicy("s1")).toBe(false);
      expect(controller.restoreHeartbeatLivenessPolicy("missing")).toBe(false);
    });
  });

  describe("adoptManagedExecutionLivenessPolicy", () => {
    test("adopts the policy with its window, anchored on the last tool call and persisted", async () => {
      const session = add("s1");
      const { lastUsedAt } = session;
      timer.advanceTime(5_000);

      await expect(
        controller.adoptManagedExecutionLivenessPolicy("s1", { idleTimeoutMs: 180_000 }),
      ).resolves.toBe(session);

      expect(session.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
      expect(session.sessionTimeoutMs).toBe(180_000);
      expect(session.expiresAt).toBe(lastUsedAt + 180_000);
      expect(session.activityGeneration).toBe(1);
      expect(port.activityWrites).toEqual([session]);
    });

    test("rolls the in-memory change back when the durable write fails", async () => {
      const session = add("s1");
      const before = { ...session };
      port.activityWrite = async () => {
        throw new Error("busy");
      };

      await expect(
        controller.adoptManagedExecutionLivenessPolicy("s1", { idleTimeoutMs: 180_000 }),
      ).rejects.toThrow("busy");

      expect(session.livenessPolicy).toBe(before.livenessPolicy);
      expect(session.sessionTimeoutMs).toBe(before.sessionTimeoutMs);
      expect(session.expiresAt).toBe(before.expiresAt);
    });

    test("an older failure does not clobber a newer change", async () => {
      const session = add("s1");
      const gate = deferred();
      port.activityWrite = () => gate.promise;

      const adoption = controller.adoptManagedExecutionLivenessPolicy("s1", {
        idleTimeoutMs: 180_000,
      });
      controller.recordHeartbeat("s1");
      gate.reject(new Error("busy"));

      await expect(adoption).rejects.toThrow("busy");
      expect(session.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
      expect(session.sessionTimeoutMs).toBe(180_000);
    });

    test("rejects an unknown session, a CLI one and an out-of-bounds window", async () => {
      await expect(controller.adoptManagedExecutionLivenessPolicy("missing")).rejects.toThrow(
        "the session is not active",
      );
      add("cli", { livenessPolicy: "cli-idle" });
      await expect(controller.adoptManagedExecutionLivenessPolicy("cli")).rejects.toThrow(
        "owned by a one-shot CLI",
      );
      add("s1");
      await expect(
        controller.adoptManagedExecutionLivenessPolicy("s1", { idleTimeoutMs: 1 }),
      ).rejects.toThrow();
      expect(port.sessions.get("s1")?.livenessPolicy).toBe("heartbeat");
    });
  });

  describe("deadline re-derivation", () => {
    test("widening never shortens and rebasing anchors on the last tool call", () => {
      const session = makeSession("s1", 1_000, { expiresAt: 900_000, sessionTimeoutMs: 100 });
      widenIdleDeadlineFromLastActivity(session);
      expect(session.expiresAt).toBe(900_000);

      rebaseIdleDeadlineOnLastActivity(session);
      expect(session.expiresAt).toBe(1_100);
    });
  });
});

describe("SessionManager port wiring (#11797)", () => {
  test("binding an acquired token looks up with the non-expiring peek, a claim with the expiring get", async () => {
    const manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
    manager.stopCleanupTimer();
    await manager.createSession("s1", "emulator-5554", "android");
    const peek = spyOn(manager, "peekSession");
    const get = spyOn(manager, "getSession");

    expect(manager.bindAcquiredLivenessOwnerToken("s1", "token-a")).toBe(true);
    expect(peek).toHaveBeenCalledWith("s1");
    expect(get).not.toHaveBeenCalled();

    await manager.claimLivenessOwnership("s1", "token-a");
    expect(get).toHaveBeenCalledWith("s1");
  });
});
