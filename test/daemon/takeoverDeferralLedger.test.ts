import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  DefaultTakeoverDeferralLedger,
  takeoverDeferralBoundExceeded,
  TAKEOVER_DEFERRAL_ATTEMPT_BOUND,
  TAKEOVER_DEFERRAL_TIME_BOUND_MS,
  TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS,
} from "../../src/daemon/manager/TakeoverDeferralLedger";
import { logger } from "../../src/utils/logger";
import { FakeStartupFailureStore } from "../fakes/FakeStartupFailureStore";
import { FakeTimer } from "../fakes/FakeTimer";

const key = { pid: 1001, startedAt: 100, processGenerationToken: "linux:old" };

describe("takeover deferral ledger", () => {
  afterEach(() => mock.restore());

  test("counts per generation and preserves the first deferral time", () => {
    const timer = new FakeTimer();
    const ledger = new DefaultTakeoverDeferralLedger(new FakeStartupFailureStore());
    timer.advanceTime(100);
    expect(ledger.recordDeferral(key, timer.now())).toEqual({
      attempts: 1,
      firstDeferredAtMs: 100,
    });
    timer.advanceTime(200);
    expect(ledger.recordDeferral({ ...key }, timer.now())).toEqual({
      attempts: 2,
      firstDeferredAtMs: 100,
    });
  });

  test.each([
    { ...key, pid: 1002 },
    { ...key, startedAt: 101 },
    { ...key, processGenerationToken: "linux:new" },
    { pid: key.pid, startedAt: key.startedAt },
  ])("a different generation resets the count: %j", (nextKey) => {
    const ledger = new DefaultTakeoverDeferralLedger(new FakeStartupFailureStore());
    ledger.recordDeferral(key, 100);
    expect(ledger.recordDeferral(nextKey, 200)).toEqual({ attempts: 1, firstDeferredAtMs: 200 });
  });

  test("survives new CLI instances and refreshes a reused instance after a peer writes", () => {
    const store = new FakeStartupFailureStore();
    const first = new DefaultTakeoverDeferralLedger(store);
    first.recordDeferral(key, 100);
    expect(new DefaultTakeoverDeferralLedger(store).recordDeferral(key, 200)).toEqual({
      attempts: 2,
      firstDeferredAtMs: 100,
    });
    expect(first.recordDeferral(key, 300)).toEqual({ attempts: 3, firstDeferredAtMs: 100 });
  });

  test.each([
    "{broken",
    "null",
    "[]",
    JSON.stringify({ key, attempts: -1, firstDeferredAtMs: 10 }),
    JSON.stringify({ key: { pid: "1001" }, attempts: 2, firstDeferredAtMs: 10 }),
    JSON.stringify({ key, attempts: 2, firstDeferredAtMs: 1e20 }),
  ])("corrupt contents start fresh: %s", (contents) => {
    const store = new FakeStartupFailureStore();
    store.contents = contents;
    spyOn(logger, "warn").mockImplementation(() => {});
    expect(new DefaultTakeoverDeferralLedger(store).recordDeferral(key, 100)).toEqual({
      attempts: 1,
      firstDeferredAtMs: 100,
    });
  });

  test("failed writes warn and keep counting in memory, then recover persistence", () => {
    const store = new FakeStartupFailureStore();
    store.failWrites = true;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const ledger = new DefaultTakeoverDeferralLedger(store);
    expect(ledger.recordDeferral(key, 100)).toEqual({ attempts: 1, firstDeferredAtMs: 100 });
    expect(ledger.recordDeferral(key, 200)).toEqual({ attempts: 2, firstDeferredAtMs: 100 });
    expect(warn).toHaveBeenCalledTimes(2);
    store.failWrites = false;
    ledger.recordDeferral(key, 300);
    expect(new DefaultTakeoverDeferralLedger(store).recordDeferral(key, 400)).toEqual({
      attempts: 4,
      firstDeferredAtMs: 100,
    });
  });

  test("a buffered attempt merges with a peer's later progress instead of overwriting it (#14401)", () => {
    const store = new FakeStartupFailureStore();
    spyOn(logger, "warn").mockImplementation(() => {});
    const first = new DefaultTakeoverDeferralLedger(store);
    const peer = new DefaultTakeoverDeferralLedger(store);
    store.failWrites = true;
    expect(first.recordDeferral(key, 100)).toEqual({ attempts: 1, firstDeferredAtMs: 100 });
    store.failWrites = false;
    peer.recordDeferral(key, 200);
    expect(peer.recordDeferral(key, 300)).toEqual({ attempts: 2, firstDeferredAtMs: 200 });
    // Four deferrals happened; the earliest was the buffered one.
    expect(first.recordDeferral(key, 400)).toEqual({ attempts: 4, firstDeferredAtMs: 100 });
    expect(new DefaultTakeoverDeferralLedger(store).recordDeferral(key, 500)).toEqual({
      attempts: 5,
      firstDeferredAtMs: 100,
    });
  });

  test("a buffered attempt for another generation does not count toward the current one", () => {
    const store = new FakeStartupFailureStore();
    spyOn(logger, "warn").mockImplementation(() => {});
    const ledger = new DefaultTakeoverDeferralLedger(store);
    store.failWrites = true;
    ledger.recordDeferral({ ...key, pid: 2002 }, 100);
    store.failWrites = false;
    expect(ledger.recordDeferral(key, 200)).toEqual({ attempts: 1, firstDeferredAtMs: 200 });
  });

  test("clear removes persisted and in-memory progress", () => {
    const store = new FakeStartupFailureStore();
    const ledger = new DefaultTakeoverDeferralLedger(store);
    ledger.recordDeferral(key, 100);
    ledger.clear();
    expect(store.contents).toBeNull();
    expect(new DefaultTakeoverDeferralLedger(store).recordDeferral(key, 200)).toEqual({
      attempts: 1,
      firstDeferredAtMs: 200,
    });
    store.failWrites = true;
    spyOn(logger, "warn").mockImplementation(() => {});
    ledger.recordDeferral(key, 300);
    ledger.clear();
    expect(ledger.recordDeferral(key, 400)).toEqual({ attempts: 1, firstDeferredAtMs: 400 });
  });
});

describe("takeover deferral bounds", () => {
  test("unavailable admission is bounded independently by attempts or elapsed time", () => {
    const timer = new FakeTimer();
    const record = { attempts: TAKEOVER_DEFERRAL_ATTEMPT_BOUND - 1, firstDeferredAtMs: 0 };
    expect(takeoverDeferralBoundExceeded("unavailable", record, timer.now())).toBe(false);
    expect(
      takeoverDeferralBoundExceeded("unavailable", { ...record, attempts: 3 }, timer.now()),
    ).toBe(true);
    timer.advanceTime(TAKEOVER_DEFERRAL_TIME_BOUND_MS - 1);
    expect(takeoverDeferralBoundExceeded("unavailable", record, timer.now())).toBe(false);
    timer.advanceTime(1);
    expect(takeoverDeferralBoundExceeded("unavailable", record, timer.now())).toBe(true);
  });

  test("active operations ignore attempt count and only cross the ten-minute time bound", () => {
    const timer = new FakeTimer();
    const record = { attempts: 100, firstDeferredAtMs: 0 };
    timer.advanceTime(TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS - 1);
    expect(takeoverDeferralBoundExceeded("active_operations", record, timer.now())).toBe(false);
    timer.advanceTime(1);
    expect(takeoverDeferralBoundExceeded("active_operations", record, timer.now())).toBe(true);
  });
});
