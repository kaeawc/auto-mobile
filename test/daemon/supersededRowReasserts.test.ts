import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import {
  SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS,
  SupersededRowReasserts,
  type OwedSupersededRowReassert,
  type OwedSupersededRowReassertCallbacks,
} from "../../src/daemon/supersededRowReasserts";
import { fixedBackoff } from "../../src/utils/Backoff";
import { FakeTimer } from "../fakes/FakeTimer";

interface Incarnation {
  readonly sessionId: string;
}

const RETRY_DELAY_MS = 40;

const releaseOf = (sessionId: string, releaseReason: string): SessionReleaseSnapshot => ({
  sessionId,
  deviceId: "emulator-5554",
  releaseReason,
  releasedAtMs: 0,
  terminal: true,
  heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 0, ageMs: 0 },
});

/** Records every scheduling event in order, so the ledger's ordering is pinned exactly. */
class RecordingRetries implements OwedSupersededRowReassertCallbacks<Incarnation> {
  readonly events: string[] = [];
  readonly drainWrites: Promise<void>[] = [];
  readonly warnings: string[] = [];

  retry(entry: OwedSupersededRowReassert<Incarnation>): Promise<boolean> {
    this.events.push(`retry:${entry.attempt}:handle=${entry.handle !== undefined}`);
    return Promise.resolve(false);
  }

  retryDuringDrain(entry: OwedSupersededRowReassert<Incarnation>): Promise<void> {
    this.events.push(`drain:${entry.attempt}:drainAttempted=${entry.drainAttempted === true}`);
    return Promise.resolve();
  }
}

describe("SupersededRowReasserts (#11799 W3)", () => {
  let timer: FakeTimer;
  let retries: RecordingRetries;
  let draining: boolean;
  let ledger: SupersededRowReasserts<Incarnation>;
  const session: Incarnation = { sessionId: "uuid-1" };

  beforeEach(() => {
    timer = new FakeTimer();
    retries = new RecordingRetries();
    draining = false;
    ledger = new SupersededRowReasserts<Incarnation>({
      timer,
      logger: { warn: (message: string) => retries.warnings.push(message) },
      draining: () => draining,
      trackDrainWrite: (write) => {
        retries.events.push("tracked");
        retries.drainWrites.push(write);
      },
    });
    ledger.setBackoff(fixedBackoff(RETRY_DELAY_MS));
  });

  test("an owed rewrite arms one retry at the backoff delay; it clears its handle before retrying", () => {
    ledger.owe(session, retries);
    expect(timer.getPendingTimeouts()).toEqual([RETRY_DELAY_MS]);
    expect(ledger.owed(session.sessionId)?.session).toBe(session);
    timer.advanceTime(RETRY_DELAY_MS - 1);
    expect(retries.events).toEqual([]);
    timer.advanceTime(1);
    expect(retries.events).toEqual(["retry:1:handle=false", "tracked"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("owing again to the same incarnation counts the attempt and re-arms once", () => {
    ledger.owe(session, retries);
    ledger.owe(session, retries);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    expect(ledger.owed(session.sessionId)?.attempt).toBe(2);
    const revived: Incarnation = { sessionId: session.sessionId };
    ledger.owe(revived, retries);
    // A revived incarnation starts over.
    expect(ledger.owed(session.sessionId)?.attempt).toBe(1);
    expect(ledger.owed(session.sessionId)?.session).toBe(revived);
    expect(timer.getPendingTimeoutCount()).toBe(1);
  });

  test("an exhausted rewrite stays owed with no timer, for the next activity write", () => {
    for (let attempt = 0; attempt <= SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS; attempt++) {
      ledger.owe(session, retries);
    }
    expect(ledger.owed(session.sessionId)?.attempt).toBe(
      SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS + 1,
    );
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(retries.warnings).toHaveLength(1);
    expect(ledger.owed(session.sessionId)?.session).toBe(session);
  });

  test("during the drain an owed rewrite is attempted at once, marked before its callback, then never again", () => {
    draining = true;
    ledger.owe(session, retries);
    expect(retries.events).toEqual(["drain:1:drainAttempted=true", "tracked"]);
    ledger.owe(session, retries);
    expect(retries.events).toEqual(["drain:1:drainAttempted=true", "tracked"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(retries.warnings).toHaveLength(1);
  });

  test("retryAllNow cancels armed timers and returns the drain attempts in owed order", async () => {
    const other: Incarnation = { sessionId: "uuid-2" };
    ledger.owe(session, retries);
    ledger.owe(other, retries);
    const writes = ledger.retryAllNow();
    expect(writes).toHaveLength(2);
    expect(retries.events).toEqual(["drain:1:drainAttempted=true", "drain:1:drainAttempted=true"]);
    await Promise.all(writes);
    timer.advanceTime(RETRY_DELAY_MS * 4);
    expect(retries.events).toHaveLength(2);
  });

  test("defer counts a failed attempt only for the current entry with no retry armed", () => {
    ledger.owe(session, retries);
    const entry = ledger.owed(session.sessionId)!;
    ledger.defer(entry);
    expect(entry.attempt).toBe(1);
    timer.advanceTime(RETRY_DELAY_MS);
    ledger.defer(entry);
    expect(entry.attempt).toBe(2);
    expect(timer.getPendingTimeouts()).toEqual([RETRY_DELAY_MS]);
    ledger.drop(entry);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    ledger.defer(entry);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(ledger.owed(session.sessionId)).toBeUndefined();
  });

  test("settle drops only the incarnation's own entry and its timer", () => {
    ledger.owe(session, retries);
    ledger.settle({ sessionId: session.sessionId });
    expect(ledger.owed(session.sessionId)).toBeDefined();
    ledger.settle(session);
    expect(ledger.owed(session.sessionId)).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("stopTimers disarms every retry and leaves the entries owed", () => {
    ledger.owe(session, retries);
    ledger.stopTimers();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(ledger.owed(session.sessionId)?.handle).toBeUndefined();
    expect(ledger.owed(session.sessionId)?.session).toBe(session);
  });

  test("pending rewrites are counted per write and each settle ends its own once", () => {
    const first = ledger.expectReassert(session.sessionId);
    const second = ledger.expectReassert(session.sessionId);
    expect(ledger.isReassertPending(session.sessionId)).toBe(true);
    first();
    first();
    expect(ledger.isReassertPending(session.sessionId)).toBe(true);
    second();
    expect(ledger.isReassertPending(session.sessionId)).toBe(false);
  });

  test("release bookkeeping: predecessors chain and refusals", () => {
    const first = releaseOf(session.sessionId, "idle-timeout");
    const second = releaseOf(session.sessionId, "device-disconnected");
    const third = releaseOf(session.sessionId, "device-killed");
    ledger.notePredecessors(second, first);
    ledger.notePredecessors(third, second);
    expect(ledger.predecessors(third)).toEqual(["idle-timeout", "device-disconnected"]);
    expect(ledger.predecessors(first)).toEqual([]);

    ledger.noteRefused(first);
    expect(ledger.wasRefused(first)).toBe(true);
    expect(ledger.wasRefused(second)).toBe(false);
  });
});
