import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import {
  getDbWriteBarrier,
  resetDbWriteBarrier,
  type DbWriteBarrier,
} from "../../src/db/dbWriteBarrier";
import {
  TelemetryRecorder,
  type TelemetryRepository,
} from "../../src/features/telemetry/TelemetryRecorder";
import type { RecordNetworkEventInput } from "../../src/db/networkEventRepository";
import type { RecordLogEventInput } from "../../src/db/logEventRepository";
import type { RecordOsEventInput } from "../../src/db/osEventRepository";
import type { RecordNavigationEventInput } from "../../src/db/navigationEventRepository";
import type { RecordStorageEventInput } from "../../src/db/storageEventRepository";
import type { RecordLayoutEventInput } from "../../src/db/layoutEventRepository";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FailureAnalyticsRepository } from "../../src/db/failureAnalyticsRepository";
import type { RecordFailureInput } from "../../src/db/failureAnalyticsRepository";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Regression tests for issue #2912 (follow-up to #2896 / PR #2905).
 *
 * #2896 made `closeDatabase()` cold-start the shared `dbWriteBarrier` via
 * `resetDbWriteBarrier()` (an identity swap). That swap only reaches consumers
 * that resolve `getDbWriteBarrier()` at USE-TIME. Consumers that CAPTURED the
 * barrier once at construction kept their pinned (drained) instance across the
 * swap, so a same-process reopen after a shutdown drain would permanently skip
 * every tracked best-effort write for them.
 *
 * #2912 decision (a) — per-call resolution — converts the three captured-reference
 * consumers (TelemetryRecorder, FailureAnalyticsRepository, SessionManager) to
 * resolve the barrier per write, matching AndroidCtrlProxyClient. Each consumer
 * now accepts a resolver `() => DbWriteBarrier`, so a test can swap the resolved
 * barrier BETWEEN construction and use to prove the consumer never pins the
 * construction-time instance.
 *
 * The shared barrier is a process-global singleton; `resetDbWriteBarrier()` in
 * `beforeEach`/`afterEach` isolates these tests from the rest of the suite.
 */
describe("captured-reference consumers survive a same-process barrier reopen (issue #2912)", () => {
  beforeEach(() => {
    resetDbWriteBarrier();
  });

  afterEach(() => {
    resetDbWriteBarrier();
  });

  /** Records whether tracked work ran, and short-circuits while draining. */
  class RecordingBarrier implements DbWriteBarrier {
    draining = false;
    trackCalls = 0;
    ranCount = 0;
    isDraining(): boolean { return this.draining; }
    inFlightCount(): number { return 0; }
    beginDrain(): void { this.draining = true; }
    async drain(): Promise<boolean> { this.draining = true; return true; }
    async track<T>(work: () => Promise<T>): Promise<T | undefined> {
      this.trackCalls += 1;
      if (this.draining) { return undefined; }
      this.ranCount += 1;
      return work();
    }
  }

  describe("TelemetryRecorder", () => {
    class FakeRepository implements TelemetryRepository {
      logEvents: RecordLogEventInput[] = [];
      async recordNetworkEvent(_input: RecordNetworkEventInput): Promise<number> { return 1; }
      async recordLogEvent(input: RecordLogEventInput): Promise<void> { this.logEvents.push(input); }
      async recordOsEvent(_input: RecordOsEventInput): Promise<void> {}
      async recordNavigationEvent(_input: RecordNavigationEventInput): Promise<void> {}
      async recordStorageEvent(_input: RecordStorageEventInput): Promise<void> {}
      async recordLayoutEvent(_input: RecordLayoutEventInput): Promise<void> {}
    }

    function makeLogInput(): RecordLogEventInput {
      return {
        timestamp: 1000,
        applicationId: "com.example",
        level: "info",
        tag: "t",
        message: "m",
      } as RecordLogEventInput;
    }

    test("resolves the barrier per write, not the construction-time instance (acceptance #1)", async () => {
      const repo = new FakeRepository();
      // Construct against a drained barrier (models the barrier pinned at shutdown).
      const drained = new RecordingBarrier();
      drained.beginDrain();
      let current: DbWriteBarrier = drained;
      const recorder = new TelemetryRecorder(repo, () => null, () => current);

      // Reopen swaps in a fresh, non-draining barrier.
      const reopened = new RecordingBarrier();
      current = reopened;

      await recorder.recordLogEvent(makeLogInput());

      // The write resolved the reopened barrier and ran; the drained one was never touched.
      expect(reopened.ranCount).toBe(1);
      expect(drained.trackCalls).toBe(0);
      expect(repo.logEvents).toHaveLength(1);
    });

    test("still short-circuits while the resolved barrier is draining (acceptance #2)", async () => {
      const repo = new FakeRepository();
      const draining = new RecordingBarrier();
      draining.beginDrain();
      const recorder = new TelemetryRecorder(repo, () => null, () => draining);

      await recorder.recordLogEvent(makeLogInput());
      expect(repo.logEvents).toHaveLength(0);
    });

    test("default resolver reads the shared singleton at use-time (acceptance #1)", async () => {
      const repo = new FakeRepository();
      const recorder = new TelemetryRecorder(repo, () => null); // default resolver

      // Drain the shared barrier, then reset (models drain -> closeDatabase).
      const shutdownBarrier = getDbWriteBarrier();
      shutdownBarrier.beginDrain();
      resetDbWriteBarrier();
      expect(getDbWriteBarrier()).not.toBe(shutdownBarrier);

      await recorder.recordLogEvent(makeLogInput());
      // Resolves the fresh singleton, not the pinned drained one.
      expect(repo.logEvents).toHaveLength(1);
    });
  });

  describe("SessionManager", () => {
    function makeRepo(): { repo: any; activity: string[] } {
      const activity: string[] = [];
      const repo = {
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(sessionId: string): Promise<void> { activity.push(sessionId); },
        async markReleased(): Promise<void> {},
        async markStaleActiveSessionsExpired(): Promise<void> {},
      };
      return { repo, activity };
    }

    test("resolves the barrier per write, not the construction-time instance (acceptance #1)", async () => {
      const timer = new FakeTimer();
      const { repo, activity } = makeRepo();
      const drained = new RecordingBarrier();
      drained.beginDrain();
      let current: DbWriteBarrier = drained;
      const mgr = new SessionManager(timer, repo, () => current);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");

        const reopened = new RecordingBarrier();
        current = reopened;

        mgr.recordHeartbeat("s1");
        await Promise.resolve();

        expect(activity).toContain("s1");
        expect(reopened.ranCount).toBeGreaterThan(0);
        expect(drained.trackCalls).toBe(0);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("still short-circuits while the resolved barrier is draining (acceptance #2)", async () => {
      const timer = new FakeTimer();
      const { repo, activity } = makeRepo();
      const draining = new RecordingBarrier();
      draining.beginDrain();
      const mgr = new SessionManager(timer, repo, () => draining);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        mgr.recordHeartbeat("s1");
        await Promise.resolve();
        expect(activity).toHaveLength(0);
      } finally {
        mgr.stopCleanupTimer();
      }
    });
  });

  describe("FailureAnalyticsRepository", () => {
    let db: Kysely<Database>;

    beforeEach(async () => {
      db = await createTestDatabase();
    });

    afterEach(async () => {
      await db.destroy();
    });

    function makeFailureInput(): RecordFailureInput {
      return {
        type: "crash",
        signature: "com.example.NullPointerException@MainActivity.onCreate",
        title: "NullPointerException in MainActivity",
        message: "Attempt to invoke method on null reference",
        severity: "critical",
        occurrence: {
          deviceModel: "Pixel 7",
          os: "Android 14",
          appVersion: "1.0.0",
          sessionId: "session-1",
        },
      };
    }

    test("resolves the barrier per write, not the construction-time instance (acceptance #1)", async () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000000);
      const drained = new RecordingBarrier();
      drained.beginDrain();
      let current: DbWriteBarrier = drained;
      const repo = new FailureAnalyticsRepository(timer, db, () => current);

      const reopened = new RecordingBarrier();
      current = reopened;

      await repo.recordFailure(makeFailureInput());
      await Promise.resolve();

      // The background retention cleanup routed through the reopened barrier.
      expect(reopened.trackCalls).toBeGreaterThan(0);
      expect(drained.trackCalls).toBe(0);
    });

    test("still short-circuits while the resolved barrier is draining (acceptance #2)", async () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000000);
      const draining = new RecordingBarrier();
      draining.beginDrain();
      const repo = new FailureAnalyticsRepository(timer, db, () => draining);

      await repo.recordFailure(makeFailureInput());
      await Promise.resolve();

      expect(draining.trackCalls).toBeGreaterThan(0);
      expect(draining.ranCount).toBe(0);
    });
  });
});
