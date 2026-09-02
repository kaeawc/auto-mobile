import { afterEach, describe, expect, it } from "bun:test";
import { awaitInFlightMigrations, awaitPromiseBounded, closeDatabase } from "../../src/db/database";
import { FakeTimer } from "../fakes/FakeTimer";
import { withInMemorySingletonDatabase } from "./inMemorySingletonDatabase";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("awaitPromiseBounded", () => {
  it("returns true immediately when nothing is in flight", async () => {
    const timer = new FakeTimer();
    expect(await awaitPromiseBounded(null, 5000, timer)).toBe(true);
    // No bound timer was ever armed.
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  it("returns true when the in-flight promise settles first, clearing the bound", async () => {
    const timer = new FakeTimer();
    const d = deferred();
    const p = awaitPromiseBounded(d.promise, 5000, timer);
    d.resolve();
    expect(await p).toBe(true);
    // The bound timer is cleared once the race resolves.
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  it("returns false when the bound elapses before the migration settles", async () => {
    const timer = new FakeTimer();
    // A promise that never resolves models a wedged mid-startup migration.
    const neverSettles = new Promise<void>(() => {});
    const p = awaitPromiseBounded(neverSettles, 5000, timer);
    timer.advanceTime(5000);
    expect(await p).toBe(false);
  });
});

describe("awaitInFlightMigrations (module state)", () => {
  afterEach(async () => {
    await closeDatabase();
  });

  it("returns true when no migration is in flight (post-close)", async () => {
    await closeDatabase();
    expect(await awaitInFlightMigrations(5000, new FakeTimer())).toBe(true);
  });

  it("returns true once the real :memory: startup migration has settled", async () => {
    await withInMemorySingletonDatabase(async () => {
      const { getDatabase, ensureMigrations } = await import("../../src/db/database");
      getDatabase();
      await ensureMigrations();
      // Migration already settled: the bound never needs to fire.
      const timer = new FakeTimer();
      expect(await awaitInFlightMigrations(5000, timer)).toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  });
});
