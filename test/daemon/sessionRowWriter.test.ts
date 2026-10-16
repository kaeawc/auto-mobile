import { describe, expect, test } from "bun:test";
import {
  SerializedSessionRowWriter,
  type DesiredReleaseRow,
  type ReleaseRowLanded,
  type ReleaseRowRetry,
  type SessionRowWriter,
} from "../../src/daemon/sessionRowWriter";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { DeviceSessionRowNotReleasableError } from "../../src/db/deviceSessionRepository";
import { sequenceBackoff } from "../../src/utils/Backoff";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeSessionRowWriter } from "../fakes/FakeSessionRowWriter";
import { FakeTimer } from "../fakes/FakeTimer";

const TIMEOUT = 100;
const flush = async () => {
  for (let i = 0; i < 80; i++) {
    await Promise.resolve();
  }
};

function desire(uuid = "uuid", terminal = true): DesiredReleaseRow {
  const snapshot: SessionReleaseSnapshot = {
    sessionId: uuid,
    deviceId: "device",
    releaseReason: terminal ? "explicit-release" : "plan-auto-release",
    releasedAtMs: 1,
    terminal,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
  };
  return { snapshot, terminal, initialPrecondition: {}, precondition: () => Promise.resolve({}) };
}

async function harness() {
  const persistence = new FakeDeviceSessionPersistence();
  const timer = new FakeTimer();
  const logger = new FakeLogger();
  const attempts: string[] = [];
  let failures = 0;
  let park: Promise<void> | undefined;
  let active = 0;
  let maxActive = 0;
  const mark = persistence.markReleased.bind(persistence);
  persistence.markReleased = async (...args) => {
    attempts.push(args[3]);
    active++;
    maxActive = Math.max(active, maxActive);
    try {
      if (park) {
        await park;
      }
      if (failures-- > 0) {
        throw new Error("busy");
      }
      await mark(...args);
    } finally {
      active--;
    }
  };
  await persistence.upsertActiveSession({
    sessionUuid: "uuid",
    deviceId: "device",
    platform: "android",
    createdAtMs: 0,
    lastUsedAtMs: 0,
    expiresAtMs: 10000,
    sessionTimeoutMs: 10000,
    heartbeatTimeoutMs: 1000,
    hasReceivedHeartbeat: false,
  });
  const writer = new SerializedSessionRowWriter(
    persistence,
    timer,
    sequenceBackoff([10, 20, 30]),
    logger,
    {
      timeoutMs: TIMEOUT,
      timeoutError: () => new Error("deadline"),
    },
  );
  return {
    persistence,
    timer,
    logger,
    writer,
    attempts,
    fail: (count: number) => {
      failures = count;
    },
    park: (gate?: Promise<void>) => {
      park = gate;
    },
    maxActive: () => maxActive,
  };
}

describe("SessionRowWriter background drain writes", () => {
  const writers = [
    ["serialized", async () => (await harness()).writer],
    ["fake", () => Promise.resolve(new FakeSessionRowWriter())],
  ] satisfies [string, () => Promise<SessionRowWriter>][];

  test.each(writers)(
    "%s retains promise identity and removes in exactly one hop",
    async (_, create) => {
      const writer = await create();
      const write = Promise.withResolvers<void>();
      writer.trackDrainWrite(write.promise);
      writer.trackDrainWrite(write.promise);
      const snapshot = Array.from(writer.pendingDrainWrites());
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]).toBe(write.promise);
      write.resolve();
      expect(Array.from(writer.pendingDrainWrites())).toEqual([write.promise]);
      await Promise.resolve();
      expect(writer.pendingDrainWrites().size).toBe(0);
      expect(snapshot).toEqual([write.promise]);

      const completed = Promise.resolve();
      writer.trackDrainWrite(completed);
      expect(Array.from(writer.pendingDrainWrites())).toEqual([completed]);
      await Promise.resolve();
      expect(writer.pendingDrainWrites().size).toBe(0);
    },
  );

  test.each(writers)("%s drains background writes added while draining", async (_, create) => {
    const writer = await create();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    writer.trackDrainWrite(first.promise);
    let drained = false;
    const drain = writer.drain().then(() => {
      drained = true;
    });
    writer.trackDrainWrite(second.promise);
    first.resolve();
    await flush();
    expect(drained).toBe(false);
    expect(Array.from(writer.pendingDrainWrites())).toEqual([second.promise]);
    second.resolve();
    await drain;
    expect(writer.pendingDrainWrites().size).toBe(0);
  });
});

describe("SessionRowWriter caller-owned non-terminal snapshots", () => {
  const writers = [
    ["serialized", async () => (await harness()).writer],
    ["fake", () => Promise.resolve(new FakeSessionRowWriter())],
  ] satisfies [string, () => Promise<SessionRowWriter>][];

  test.each(writers)(
    "%s evicts the oldest non-terminal snapshot without evicting a terminal retry",
    async (_, create) => {
      const writer = await create();
      const terminal = desire("terminal").snapshot;
      let ran: ReleaseRowRetry | undefined;
      writer.scheduleRetry(terminal, {
        isStillOwed: () => true,
        drop: () => writer.cancelRetry(terminal),
        run: (entry) => {
          ran = entry;
          return Promise.resolve();
        },
      });
      const snapshots = Array.from(
        { length: 257 },
        (_, index) => desire(`n-${index}`, false).snapshot,
      );
      for (const snapshot of snapshots.slice(0, 256)) {
        writer.recordPendingNonTerminalRelease(snapshot);
      }
      const pending = writer.pendingNonTerminalReleases();
      expect(pending.size).toBe(256);
      expect(pending.get("n-0")).toBe(snapshots[0]);
      // Replacing a value at the cap neither evicts nor refreshes its insertion position.
      const replacement = { ...snapshots[0]!, releaseReason: "allocation-rollback" };
      writer.recordPendingNonTerminalRelease(replacement);
      expect(pending.size).toBe(256);
      expect(pending.get("n-0")).toBe(replacement);
      writer.recordPendingNonTerminalRelease(snapshots[256]!);
      expect(pending.size).toBe(256);
      expect(pending.has("n-0")).toBe(false);
      expect(pending.get("n-1")).toBe(snapshots[1]);
      expect(pending.get("n-256")).toBe(snapshots[256]);
      expect(writer.pending("terminal")).toBe(true);
      writer.stopRetryTimers();
      await Promise.all(writer.retryPendingNow());
      expect(ran?.snapshot).toBe(terminal);
      expect(ran?.isCurrent()).toBe(true);
      writer.cancelRetry(terminal);
      writer.clearPendingNonTerminalReleases();
      await writer.drain();
    },
  );

  test.each(writers)(
    "%s preserves snapshot identity and live insertion-order iteration",
    async (_, create) => {
      const writer = await create();
      const first = desire("first", false).snapshot;
      const second = desire("second", false).snapshot;
      const replacement = { ...first };
      const pending = writer.pendingNonTerminalReleases();
      writer.recordPendingNonTerminalRelease(first);
      writer.recordPendingNonTerminalRelease(second);
      writer.recordPendingNonTerminalRelease(replacement);
      expect(Array.from(pending.keys())).toEqual(["first", "second"]);
      expect(pending.get("first")).toBe(replacement);
      const iterator = pending.values();
      expect(iterator.next().value).toBe(replacement);
      writer.deletePendingNonTerminalRelease("second");
      writer.deletePendingNonTerminalRelease("missing");
      writer.recordPendingNonTerminalRelease(second);
      expect(iterator.next().value).toBe(second);
      writer.deletePendingNonTerminalRelease("first");
      writer.recordPendingNonTerminalRelease(first);
      expect(Array.from(pending.keys())).toEqual(["second", "first"]);
      expect(pending.get("first")).toBe(first);
      writer.clearPendingNonTerminalReleases();
      expect(pending.size).toBe(0);
    },
  );

  test.each(writers)(
    "%s clearing snapshots leaves independently scheduled retries intact",
    async (_, create) => {
      const writer = await create();
      const snapshot = desire("uuid", false).snapshot;
      writer.recordPendingNonTerminalRelease(snapshot);
      writer.scheduleRetry(snapshot, {
        isStillOwed: () => true,
        drop: () => writer.cancelRetry(snapshot),
        run: () => Promise.resolve(),
      });
      writer.clearPendingNonTerminalReleases();
      expect(writer.pendingNonTerminalReleases().size).toBe(0);
      expect(writer.pending("uuid")).toBe(true);
      writer.cancelRetry(snapshot);
      await writer.drain();
    },
  );
});

describe("SessionRowWriter release statements", () => {
  test("lands the desired row and settles without real sleeps", async () => {
    const h = await harness();
    const events: ReleaseRowLanded[] = [];
    h.writer.onRowLanded((event) => {
      events.push(event);
    });
    const desired = desire();
    h.writer.desire("uuid", desired);
    const result = h.writer.result("uuid");
    await h.writer.settled("uuid");
    expect(await result).toBe(true);
    expect((await h.persistence.getSession("uuid"))?.release_reason).toBe("explicit-release");
    expect(events).toEqual([{ snapshot: desired.snapshot, late: false, refused: false }]);
    expect(h.writer.pending("uuid")).toBe(false);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("replaces an unwritten desire while an issued write remains serialized", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.park(gate.promise);
    h.writer.desire("uuid", desire("uuid", false));
    let firstSettled = false;
    const firstOutcome = h.writer.result("uuid").then((result) => {
      firstSettled = true;
      return result;
    });
    h.writer.desire("uuid", {
      ...desire(),
      snapshot: { ...desire().snapshot, releaseReason: "owner-disconnected" },
    });
    h.writer.desire("uuid", desire());
    expect(h.attempts).toEqual(["plan-auto-release"]);
    await flush();
    expect(firstSettled).toBe(false);
    h.park();
    gate.resolve();
    await h.writer.settled("uuid");
    expect(await firstOutcome).toBe(true);
    expect(h.attempts).toEqual(["plan-auto-release", "explicit-release"]);
    expect(h.maxActive()).toBe(1);
  });

  test("terminal desires take precedence until explicitly lifted", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.park(gate.promise);
    const terminal = desire();
    h.writer.desire("uuid", terminal);
    h.writer.desire("uuid", desire("uuid", false));
    expect(h.writer.pendingSnapshot("uuid")).toBe(terminal.snapshot);
    h.writer.liftTerminal("uuid");
    h.writer.desire("uuid", desire("uuid", false));
    h.park();
    gate.resolve();
    await h.writer.settled("uuid");
    expect(h.attempts).toEqual(["explicit-release", "plan-auto-release"]);
    expect(h.maxActive()).toBe(1);
  });

  test("a deadline frees the slot while retaining the parked statement's late callback", async () => {
    const h = await harness();
    const events: ReleaseRowLanded[] = [];
    h.writer.onRowLanded((event) => {
      events.push(event);
    });
    const gate = Promise.withResolvers<void>();
    h.park(gate.promise);
    const old = desire("uuid", false);
    h.writer.desire("uuid", old);
    const first = h.writer.result("uuid");
    h.writer.desire("uuid", desire());
    await h.timer.advanceTimeAsync(TIMEOUT - 1);
    expect(h.attempts).toEqual(["plan-auto-release"]);
    expect(h.maxActive()).toBe(1);
    h.park();
    await h.timer.advanceTimeAsync(1);
    await flush();
    expect(await first).toBe(false);
    expect(h.attempts).toEqual(["plan-auto-release", "explicit-release"]);
    expect(h.maxActive()).toBe(2);
    expect(h.writer.pending("uuid")).toBe(true);
    let settled = false;
    const completion = h.writer.settled("uuid").then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    gate.resolve();
    await completion;
    expect(events).toContainEqual({ snapshot: old.snapshot, late: true, refused: false });
    expect(h.writer.pending("uuid")).toBe(false);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("settling a parked write never unlocks a newer unexpired write", async () => {
    const h = await harness();
    const old = Promise.withResolvers<void>();
    const newer = Promise.withResolvers<void>();
    h.park(old.promise);
    h.writer.desire("uuid", desire("uuid", false));
    await h.timer.advanceTimeAsync(TIMEOUT);
    h.park(newer.promise);
    h.writer.desire("uuid", desire());
    old.resolve();
    await flush();
    h.writer.desire("uuid", desire());
    expect(h.attempts).toHaveLength(2);
    h.park();
    newer.resolve();
    await h.writer.settled("uuid");
    expect(h.attempts).toHaveLength(3);
  });

  test("drain retains a parked write after a newer desire lands", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.park(gate.promise);
    h.writer.desire("uuid", desire("uuid", false));
    await h.timer.advanceTimeAsync(TIMEOUT);
    h.park();
    h.writer.desire("uuid", desire());
    let drained = false;
    const drain = h.writer.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    gate.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });

  test("retries use the injected backoff sequence and reread the precondition", async () => {
    const h = await harness();
    h.fail(2);
    let reads = 0;
    const desired = desire();
    desired.precondition = () => {
      reads++;
      return Promise.resolve({});
    };
    h.writer.desire("uuid", desired);
    await flush();
    expect(h.timer.getPendingTimeouts()).toEqual([10]);
    await h.timer.advanceTimeAsync(10);
    await flush();
    expect(h.timer.getPendingTimeouts()).toEqual([20]);
    await h.timer.advanceTimeAsync(20);
    await h.writer.settled("uuid");
    expect(reads).toBe(2);
    expect(h.attempts).toHaveLength(3);
  });

  test("drain retries an owed snapshot exactly once without timers", async () => {
    const h = await harness();
    h.fail(100);
    h.writer.desire("uuid", desire());
    await flush();
    await h.writer.drain();
    expect(h.attempts).toHaveLength(2);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    expect(h.writer.pending("uuid")).toBe(false);
    expect(h.logger.at("warn").at(-1)?.message).toContain("shutdown");
  });

  test("drain also retries once when the initial attempt fails during drain", async () => {
    const h = await harness();
    h.fail(2);
    h.writer.desire("uuid", desire());
    await h.writer.drain();
    expect(h.attempts).toHaveLength(2);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });

  test("settled never rejects even when the first-attempt adapter throws", async () => {
    const h = await harness();
    h.fail(2);
    const desired = desire();
    desired.failure = () => {
      throw new Error("typed failure");
    };
    h.writer.desire("uuid", desired);
    const result = h.writer.result("uuid");
    const settled = h.writer.settled("uuid");
    await expect(result).rejects.toThrow("typed failure");
    await h.writer.drain();
    await expect(settled).resolves.toBeUndefined();
  });

  test("lift cancels an unwritten terminal desire without owning another snapshot", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.park(gate.promise);
    const first = desire("uuid", false);
    h.writer.desire("uuid", first);
    const terminal = desire();
    h.writer.desire("uuid", terminal);
    h.writer.cancel("uuid", first.snapshot);
    expect(h.writer.pendingSnapshot("uuid")).toBe(terminal.snapshot);
    h.writer.liftTerminal("uuid");
    h.park();
    gate.resolve();
    await h.writer.settled("uuid");
    expect(h.attempts).toEqual(["plan-auto-release"]);
  });

  test("lift leaves a non-terminal desire intact", async () => {
    const h = await harness();
    h.fail(1);
    h.writer.desire("uuid", desire("uuid", false));
    await flush();
    h.writer.liftTerminal("uuid");
    expect(h.writer.pending("uuid")).toBe(true);
    await h.writer.drain();
    expect((await h.persistence.getSession("uuid"))?.release_reason).toBe("plan-auto-release");
  });

  test("evicts the oldest of 257 non-terminal desires and retains terminal desires", async () => {
    const h = await harness();
    h.persistence.failure = "release";
    const terminal = desire("terminal");
    h.writer.desire("terminal", terminal);
    for (let i = 0; i < 257; i++) {
      h.writer.desire(`n-${i}`, desire(`n-${i}`, false));
      await flush();
    }
    expect(h.writer.pending("n-0")).toBe(false);
    expect(h.writer.pending("n-1")).toBe(true);
    expect(h.writer.pending("n-256")).toBe(true);
    expect(h.writer.pending("terminal")).toBe(true);
    h.writer.stop();
    h.writer.cancel("terminal", terminal.snapshot);
    await h.writer.drain();
  });

  test("a skipped non-terminal generation remains owed", async () => {
    const h = await harness();
    h.fail(1);
    let skipped = true;
    const desired = desire("uuid", false);
    desired.skipped = () => Promise.resolve(skipped);
    h.writer.desire("uuid", desired);
    await flush();
    await h.timer.advanceTimeAsync(10);
    await flush();
    expect(h.writer.pending("uuid")).toBe(true);
    expect(h.timer.getPendingTimeouts()).toEqual([20]);
    skipped = false;
    await h.timer.advanceTimeAsync(20);
    await h.writer.settled("uuid");
    expect(h.attempts).toHaveLength(3);
  });

  test("a refusal is observed once and is not retried", async () => {
    const h = await harness();
    const events: ReleaseRowLanded[] = [];
    h.writer.onRowLanded((event) => {
      events.push(event);
    });
    const desired = desire();
    desired.initialPrecondition = {
      expectedRowGeneration: 99,
      unlessTerminalOrOwnedByLivePeer: {
        livePeerDaemonSessionIds: [],
        reportRefusal: true,
      },
    };
    h.writer.desire("uuid", desired);
    await h.writer.settled("uuid");
    expect(events[0]?.refused).toBe(true);
    expect(h.attempts).toHaveLength(1);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });

  test("a late refusal invokes its single-flight fallback only once", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.persistence.markReleased = async () => {
      await gate.promise;
      throw new DeviceSessionRowNotReleasableError("uuid");
    };
    let fallbacks = 0;
    const desired = desire();
    desired.fallback = () => {
      fallbacks++;
      return Promise.resolve();
    };
    h.writer.desire("uuid", desired);
    await h.timer.advanceTimeAsync(TIMEOUT);
    gate.resolve();
    await h.writer.settled("uuid");
    expect(fallbacks).toBe(1);
  });

  test("a parked old terminal statement cannot overwrite a recreated SQL generation", async () => {
    const h = await harness();
    const events: ReleaseRowLanded[] = [];
    h.writer.onRowLanded((event) => {
      events.push(event);
    });
    const gate = Promise.withResolvers<void>();
    h.park(gate.promise);
    const terminal = desire();
    terminal.initialPrecondition = {
      expectedRowGeneration: 1,
      unlessTerminalOrOwnedByLivePeer: {
        livePeerDaemonSessionIds: [],
        reportRefusal: true,
      },
    };
    h.writer.desire("uuid", terminal);
    await h.timer.advanceTimeAsync(TIMEOUT);
    h.writer.liftTerminal("uuid");
    const generation = await h.persistence.upsertActiveSession({
      sessionUuid: "uuid",
      deviceId: "new",
      platform: "android",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      expiresAtMs: 10000,
      sessionTimeoutMs: 10000,
      heartbeatTimeoutMs: 1000,
      hasReceivedHeartbeat: false,
    });
    h.park();
    gate.resolve();
    await h.writer.settled("uuid");
    expect(events).toContainEqual({ snapshot: terminal.snapshot, late: true, refused: true });
    expect(await h.persistence.getSession("uuid")).toMatchObject({
      status: "active",
      device_id: "new",
      release_reason: null,
      stable_identity_generation: generation,
    });
  });

  test("lifting before the precondition resumes refuses an uncaptured terminal generation", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    const terminal = desire();
    delete terminal.initialPrecondition;
    terminal.precondition = async () => {
      await gate.promise;
      return {};
    };
    h.writer.desire("uuid", terminal);
    h.writer.liftTerminal("uuid");
    gate.resolve();
    await h.writer.settled("uuid");
    expect(h.attempts).toEqual([]);
  });

  test("stop clears retry timers and forgets only non-terminal owed rows", async () => {
    const h = await harness();
    h.fail(2);
    h.writer.desire("uuid", desire());
    h.writer.desire("other", desire("other", false));
    await flush();
    h.writer.stop();
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    expect(h.writer.pending("uuid")).toBe(true);
    expect(h.writer.pending("other")).toBe(false);
    await h.writer.drain();
  });

  test("the injectable fake exposes the same ownership and completion surface", async () => {
    const writer = new FakeSessionRowWriter();
    const terminal = desire();
    writer.desire("uuid", terminal);
    const result = writer.result("uuid");
    const settled = writer.settled("uuid");
    writer.cancel("uuid", desire().snapshot);
    expect(writer.pending("uuid")).toBe(true);
    await writer.land("uuid");
    expect(await result).toBe(true);
    await settled;
    await writer.drain();
    expect(writer.pending("uuid")).toBe(false);
  });
});

describe("SessionRowWriter caller-owned retry writes", () => {
  test("preserves backoff, timer FIFO order and synchronous callback entry", async () => {
    const h = await harness();
    const snapshot = desire().snapshot;
    const order: string[] = [];
    const entries: ReleaseRowRetry[] = [];
    const gate = Promise.withResolvers<void>();
    const callbacks = {
      isStillOwed: () => true,
      drop: () => h.writer.cancelRetry(snapshot),
      run: (entry: ReleaseRowRetry) => {
        entries.push(entry);
        order.push("retry");
        return gate.promise;
      },
    };
    h.timer.setTimeout(() => order.push("before"), 10);
    h.writer.scheduleRetry(snapshot, callbacks);
    h.timer.setTimeout(() => order.push("after"), 10);
    expect(h.timer.getPendingTimeouts()).toEqual([10, 10, 10]);
    h.timer.advanceTime(10);
    expect(order).toEqual(["before", "retry", "after"]);
    expect(entries[0]?.isCurrent()).toBe(true);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    h.writer.scheduleRetry(snapshot, callbacks);
    expect(entries[0]?.isCurrent()).toBe(false);
    expect(h.timer.getPendingTimeouts()).toEqual([20]);
    let settled = false;
    const completion = h.writer.settled(snapshot.sessionId).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.timer.advanceTime(20);
    expect(entries).toHaveLength(2);
    h.writer.cancelRetry(snapshot);
    gate.resolve();
    await completion;
    expect(settled).toBe(true);
    expect(h.writer.pending(snapshot.sessionId)).toBe(false);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("a terminal retry replaces a non-terminal retry and never the reverse", async () => {
    const h = await harness();
    const nonTerminal = desire("uuid", false).snapshot;
    const terminal = desire().snapshot;
    const ran: SessionReleaseSnapshot[] = [];
    let checks = 0;
    const callbacks = (snapshot: SessionReleaseSnapshot) => ({
      isStillOwed: () => {
        checks++;
        return true;
      },
      drop: () => h.writer.cancelRetry(snapshot),
      run: () => {
        ran.push(snapshot);
        return Promise.resolve();
      },
    });
    h.writer.scheduleRetry(nonTerminal, callbacks(nonTerminal));
    h.writer.scheduleRetry(nonTerminal, callbacks(nonTerminal));
    expect(h.timer.getPendingTimeouts()).toEqual([20]);
    const settled = h.writer.settled("uuid");
    h.writer.scheduleRetry(terminal, callbacks(terminal));
    expect(h.timer.getPendingTimeouts()).toEqual([10]);
    h.writer.scheduleRetry(nonTerminal, callbacks(nonTerminal));
    expect(checks).toBe(3);
    h.writer.cancelRetry(nonTerminal);
    expect(h.writer.pending("uuid")).toBe(true);
    h.timer.advanceTime(10);
    expect(ran).toEqual([terminal]);
    h.writer.cancelRetry(terminal);
    await settled;
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });

  test("a replacement preserves settlement waiters and resets the attempt", async () => {
    const h = await harness();
    const old = desire().snapshot;
    const newer = { ...old, releaseReason: "owner-disconnected" };
    const callbacks = {
      isStillOwed: () => true,
      drop: () => h.writer.cancelRetry(old),
      run: () => Promise.resolve(),
    };
    h.writer.scheduleRetry(old, callbacks);
    h.writer.scheduleRetry(old, callbacks);
    let settled = false;
    const completion = h.writer.settled("uuid").then(() => {
      settled = true;
    });
    h.writer.scheduleRetry(newer, callbacks);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.timer.getPendingTimeouts()).toEqual([10]);
    h.writer.cancelRetry(old);
    expect(h.writer.pending("uuid")).toBe(true);
    h.writer.cancelRetry(newer);
    await completion;
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });

  test("drain returns original write promises, cancels timers and gives up after one failure", async () => {
    const h = await harness();
    const snapshot = desire().snapshot;
    const gate = Promise.withResolvers<void>();
    let runs = 0;
    const callbacks = {
      isStillOwed: () => true,
      drop: () => h.writer.cancelRetry(snapshot),
      run: (entry: ReleaseRowRetry) => {
        runs++;
        expect(entry.shutdownAttempted).toBe(true);
        return gate.promise;
      },
    };
    h.writer.scheduleRetry(snapshot, callbacks);
    const settled = h.writer.settled("uuid");
    h.writer.beginReleaseDrain();
    const writes = h.writer.retryPendingNow();
    expect(writes).toEqual([gate.promise]);
    expect(runs).toBe(1);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    h.writer.scheduleRetry(snapshot, callbacks);
    expect(runs).toBe(1);
    expect(h.writer.pending("uuid")).toBe(false);
    expect(h.logger.at("warn").at(-1)?.message).toContain("still not persisted at shutdown");
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    gate.resolve();
    await settled;
    await h.writer.drain();
  });

  test.each([true, false])(
    "a new owed snapshot during drain runs immediately, terminal=%s",
    async (terminal) => {
      const h = await harness();
      const snapshot = desire("uuid", terminal).snapshot;
      const gate = Promise.withResolvers<void>();
      let runs = 0;
      const callbacks = {
        isStillOwed: () => true,
        drop: () => h.writer.cancelRetry(snapshot),
        run: () => {
          runs++;
          return gate.promise;
        },
      };
      h.writer.beginReleaseDrain();
      h.writer.scheduleRetry(snapshot, callbacks);
      expect(runs).toBe(1);
      expect(Array.from(h.writer.pendingDrainWrites())).toEqual([gate.promise]);
      expect(h.timer.getPendingTimeouts()).toEqual([]);
      h.writer.scheduleRetry(snapshot, callbacks);
      expect(runs).toBe(1);
      expect(h.writer.pending("uuid")).toBe(false);
      gate.resolve();
      await h.writer.drain();
      expect(h.timer.getSleepHistory()).toEqual([]);
    },
  );

  test("stop clears handles but retains both retry kinds for shutdown", async () => {
    const h = await harness();
    const snapshots = [desire().snapshot, desire("other", false).snapshot];
    const ran: string[] = [];
    for (const snapshot of snapshots) {
      h.writer.scheduleRetry(snapshot, {
        isStillOwed: () => true,
        drop: () => h.writer.cancelRetry(snapshot),
        run: () => {
          ran.push(snapshot.sessionId);
          h.writer.cancelRetry(snapshot);
          return Promise.resolve();
        },
      });
    }
    h.writer.stopRetryTimers();
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    expect(snapshots.map((snapshot) => h.writer.pending(snapshot.sessionId))).toEqual([true, true]);
    h.timer.advanceTime(100);
    expect(ran).toEqual([]);
    await h.writer.drain();
    expect(ran).toEqual(["uuid", "other"]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("an unowed retry calls the owner's drop synchronously", async () => {
    const h = await harness();
    const snapshot = desire().snapshot;
    let drops = 0;
    let runs = 0;
    const callbacks = {
      isStillOwed: () => true,
      drop: () => {
        drops++;
        h.writer.cancelRetry(snapshot);
      },
      run: () => {
        runs++;
        return Promise.resolve();
      },
    };
    h.writer.scheduleRetry(snapshot, callbacks);
    const settled = h.writer.settled("uuid");
    h.writer.scheduleRetry(snapshot, { ...callbacks, isStillOwed: () => false });
    expect(drops).toBe(1);
    expect(runs).toBe(0);
    expect(h.writer.pending("uuid")).toBe(false);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    await settled;
  });

  test("the manual fake exposes pending and settled for caller-owned retries", async () => {
    const writer = new FakeSessionRowWriter();
    const snapshot = desire().snapshot;
    const write = Promise.resolve();
    writer.scheduleRetry(snapshot, {
      isStillOwed: () => true,
      drop: () => writer.cancelRetry(snapshot),
      run: () => write,
    });
    let settled = false;
    const completion = writer.settled("uuid").then(() => {
      settled = true;
    });
    expect(writer.pending("uuid")).toBe(true);
    writer.beginReleaseDrain();
    expect(writer.retryPendingNow()).toEqual([write]);
    await Promise.resolve();
    expect(settled).toBe(false);
    writer.cancelRetry(snapshot);
    await completion;
    expect(writer.pending("uuid")).toBe(false);
  });
});

test("settled spans row replacement while a caller-owned retry remains pending", async () => {
  const h = await harness();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const snapshot = desire("uuid", false).snapshot;
  h.park(first.promise);
  h.writer.desire("uuid", desire("uuid", false));
  h.writer.scheduleRetry(snapshot, {
    isStillOwed: () => true,
    drop: () => h.writer.cancelRetry(snapshot),
    run: () => Promise.resolve(),
  });
  let settled = false;
  const completion = h.writer.settled("uuid").then(() => {
    settled = true;
  });
  first.resolve();
  await flush();
  expect(settled).toBe(false);
  h.park(second.promise);
  h.writer.desire("uuid", desire());
  h.writer.cancelRetry(snapshot);
  await flush();
  expect(h.writer.pending("uuid")).toBe(true);
  expect(settled).toBe(false);
  second.resolve();
  await completion;
  expect(h.writer.pending("uuid")).toBe(false);
  expect(h.timer.getPendingTimeouts()).toEqual([]);
  expect(h.timer.getSleepHistory()).toEqual([]);
});
