import { describe, expect, test } from "bun:test";
import {
  DefaultStartupFailureTracker,
  type StartupFailureStore,
} from "../../src/daemon/DaemonStartupFailureTracker";

/**
 * In-memory store modeling cross-process persistence: state survives across
 * tracker instances (fresh respawned processes read the same backing store).
 */
class InMemoryStore implements StartupFailureStore {
  data: string | null = null;
  read(): string | null {
    return this.data;
  }
  write(value: string): void {
    this.data = value;
  }
  clear(): void {
    this.data = null;
  }
}

/** A store whose writes always fail — models an unwritable state directory. */
class UnwritableStore implements StartupFailureStore {
  read(): string | null {
    return null;
  }
  write(): void {
    throw new Error("EACCES: permission denied");
  }
  clear(): void {
    // no-op
  }
}

describe("DefaultStartupFailureTracker", () => {
  test("persists an escalating count across independent tracker instances (fresh processes)", () => {
    const store = new InMemoryStore();
    expect(new DefaultStartupFailureTracker(store).recordFailure("permanent", 1_000)).toBe(1);
    expect(new DefaultStartupFailureTracker(store).recordFailure("permanent", 2_000)).toBe(2);
    expect(new DefaultStartupFailureTracker(store).recordFailure("permanent", 3_000)).toBe(3);
  });

  test("drops failures older than the rolling window", () => {
    const store = new InMemoryStore();
    const windowMs = 5_000;
    expect(
      new DefaultStartupFailureTracker(store, windowMs).recordFailure("permanent", 1_000),
    ).toBe(1);
    // 10s later — the first failure has aged out of the 5s window.
    expect(
      new DefaultStartupFailureTracker(store, windowMs).recordFailure("permanent", 11_000),
    ).toBe(1);
  });

  test("reset clears persisted state", () => {
    const store = new InMemoryStore();
    const tracker = new DefaultStartupFailureTracker(store);
    tracker.recordFailure("permanent", 1_000);
    expect(store.data).not.toBeNull();
    tracker.reset();
    expect(store.data).toBeNull();
    expect(new DefaultStartupFailureTracker(store).recordFailure("permanent", 2_000)).toBe(1);
  });

  test("ignores corrupt persisted contents (treats as no prior failures)", () => {
    const store = new InMemoryStore();
    store.data = "not-json{";
    expect(new DefaultStartupFailureTracker(store).recordFailure("permanent", 1_000)).toBe(1);
  });

  test("throttles when persistence itself fails (unwritable state dir)", () => {
    // A permanent failure whose escalation cannot be persisted must still report a
    // backoff-triggering count so it does not hot-loop at count 1 forever.
    const tracker = new DefaultStartupFailureTracker(new UnwritableStore());
    expect(tracker.recordFailure("permanent", 1_000)).toBeGreaterThanOrEqual(2);
  });
});
