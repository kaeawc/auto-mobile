import { describe, expect, test } from "bun:test";
import {
  SerializedSessionRowWriter,
  type DesiredReleaseRow,
  type ReleaseRowLanded,
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
