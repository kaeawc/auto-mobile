import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BrokerExecutionRelease,
  managedExecutionSessionsFrom,
  type ManagedExecutionSessions,
  type ManagedExecutionWork,
} from "../../../../src/daemon/sessionBroker/provisioning/executionRelease";
import type { KeepAwakeRestoreReport } from "../../../../src/utils/KeepScreenAwakeManager";
import { FakeDbWriteBarrier } from "../../../fakes/FakeDbWriteBarrier";
import type { BindingKey } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { BindingJournalInFlight } from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../../../src/daemon/sessionBroker/provisioning/executionLiveness";
import { logger } from "../../../../src/utils/logger";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

// #11177: ending a managed execution drains its work and releases its live control, but the binding
// keeps its device: the assignment (binding, generation) survives and generic allocation stays
// excluded. Unsettled work leaves the binding `settling` (outcome `cleanup_pending`) until it settles.

const SETTLER = { daemonId: "daemon-a", pid: 4242, processGenerationToken: "linux:boot:1" };
const S1 = "session-1";
const S2 = "session-2";
const DEVICE = "emulator-5554";
const AVD = "Pixel_8_API_35";
const BINDING = { generation: 1, stableDeviceId: AVD };
/** Entering settling fences the binding: same device, next generation. */
const FENCED = { generation: 2, stableDeviceId: AVD };

class FakeWork implements ManagedExecutionWork {
  readonly active = new Map<string, number>();
  /** When false, cancelled work keeps running (an action ignoring its abort). */
  endOnCancel = true;
  readonly cancelled: string[] = [];

  async cancelDeviceSessionExecutions(sessionId: string): Promise<number> {
    this.cancelled.push(sessionId);
    const count = this.active.get(sessionId) ?? 0;
    if (this.endOnCancel) {
      this.active.delete(sessionId);
    }
    return count;
  }

  async waitForDeviceSessionExecutionsToEnd(
    sessionId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.active.has(sessionId)) {
      return true;
    }
    await this.timer.sleep(timeoutMs);
    return !this.active.has(sessionId);
  }

  hasActiveDeviceSessionExecutions(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  constructor(private readonly timer: FakeTimer) {}
}

class FakeSessions implements ManagedExecutionSessions {
  readonly live = new Map<string, string>();
  readonly released: string[] = [];
  readonly forced: string[] = [];
  readonly cleanupInProgress = new Set<string>();
  hangRelease = false;
  report: KeepAwakeRestoreReport | undefined;

  getKeepAwakeRestoreReport(sessionId: string) {
    expect(this.live.has(sessionId)).toBe(false);
    return this.report;
  }

  isSessionLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  deviceOf(sessionId: string): string | null {
    return this.live.get(sessionId) ?? null;
  }

  releaseSession(sessionId: string): Promise<string | null> {
    if (this.hangRelease) {
      return new Promise(() => {});
    }
    const device = this.live.get(sessionId) ?? null;
    this.live.delete(sessionId);
    this.released.push(sessionId);
    return Promise.resolve(device);
  }

  async forceStuckRelease(sessionId: string): Promise<boolean> {
    this.forced.push(sessionId);
    const device = this.live.get(sessionId);
    this.live.delete(sessionId);
    if (device) {
      this.cleanupInProgress.add(device);
    }
    return true;
  }

  hasDeviceCleanupInProgress(deviceId: string): boolean {
    return this.cleanupInProgress.has(deviceId);
  }
}

describe("managed execution release (daemon/releaseExecution)", () => {
  let timer: FakeTimer;
  let registry: FakeBindingRegistry;
  let work: FakeWork;
  let sessions: FakeSessions;
  let drain: BrokerExecutionRelease;
  let key: BindingKey;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = new FakeBindingRegistry(timer);
    work = new FakeWork(timer);
    sessions = new FakeSessions();
    drain = new BrokerExecutionRelease({
      registry: async () => registry,
      work,
      sessions,
      timer,
      settler: SETTLER,
    });
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "runner-a",
      runnerIncarnation: "boot-1",
    });
    if (scope.kind !== "ready") {
      throw new Error(`scope not ready: ${scope.kind}`);
    }
    key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, { role: "primary", platform: "android", requestedSpec: {} });
    await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: AVD,
        deviceName: "amslot-test-0-g1",
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
      },
    );
    await claim(S1);
  });

  afterEach(() => {
    drain.close();
    warn.mockRestore();
  });

  async function claim(sessionId: string): Promise<void> {
    const claimed = await registry.claimExecution(key, BINDING, {
      daemonId: "daemon",
      pid: 1,
      sessionUuid: sessionId,
    });
    expect(claimed.kind).toBe("claimed");
    sessions.live.set(sessionId, DEVICE);
  }

  test("release drains, ends live control, and keeps the binding's device assignment", async () => {
    work.active.set(S1, 2);

    const result = await drain.releaseExecution(S1);

    expect(result).toMatchObject({
      sessionId: S1,
      outcome: "reusable_for_this_binding",
      settlement: "confirmed",
      alreadyReleased: false,
      cancellationRequested: 2,
      releaseForced: false,
      device: DEVICE,
      bindingFailures: [],
    });
    expect(result.bindings).toEqual([
      expect.objectContaining({
        bindingIndex: 0,
        stableDeviceId: AVD,
        generation: 1,
        state: "ready",
      }),
    ]);
    expect(result.bindings[0]?.execOwnerReleased).toBe(true);
    expect(work.cancelled).toEqual([S1]);
    expect(sessions.released).toEqual([S1]);
    expect(await registry.getAssignment(key)).toMatchObject({
      ...BINDING,
      state: "ready",
      execOwner: null,
    });
  });

  test.each([undefined, "restored_to_baseline", "failed"] as const)(
    "release result adds only a known keep-awake report (%s)",
    async (reported) => {
      const report: KeepAwakeRestoreReport = {
        status: reported ?? "failed",
        settings: [
          reported === "restored_to_baseline"
            ? { setting: "svc_stayon", value: "false" }
            : { setting: "svc_stayon", error: "write rejected" },
        ],
      };
      sessions.report = reported ? report : undefined;
      const result = await drain.releaseExecution(S1);
      expect(result).toEqual({
        sessionId: S1,
        outcome: "reusable_for_this_binding",
        settlement: "confirmed",
        alreadyReleased: false,
        cancellationRequested: 0,
        releaseForced: false,
        device: DEVICE,
        bindings: [expect.objectContaining({ bindingIndex: 0, execOwnerReleased: true })],
        bindingFailures: [],
        ...(reported ? { keepAwakeRestore: report } : {}),
      });
      expect((await drain.releaseExecution(S1)).keepAwakeRestore).toEqual(sessions.report);
    },
  );

  test("generic allocation stays excluded after release; the binding's next execution may claim", async () => {
    await drain.releaseExecution(S1);

    // Generic exclusion reads these: the device is still held by the binding, not freed.
    expect(await registry.isDeviceAssignedToValidBinding("android", AVD)).toBe(true);
    expect(await registry.snapshotManagedDevices()).toEqual([
      expect.objectContaining({ stableDeviceId: AVD, holder: "session_broker", bindingIndex: 0 }),
    ]);
    await claim(S2);
  });

  test("unsettled work leaves the binding settling, blocks the next claim, then settles", async () => {
    timer.enableAutoAdvance();
    work.endOnCancel = false;
    work.active.set(S1, 1);

    const result = await drain.releaseExecution(S1);

    expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
    expect(result.bindings[0]).toMatchObject({ state: "settling", execOwnerReleased: true });
    expect(sessions.released).toEqual([S1]);
    expect(await registry.getAssignment(key)).toMatchObject({
      ...FENCED,
      state: "settling",
      settler: SETTLER,
      execOwner: null,
    });
    // The assignment is protected, not freed: the binding's next acquisition waits.
    expect(await registry.isDeviceAssignedToValidBinding("android", AVD)).toBe(true);
    const owner = { daemonId: "daemon", pid: 1, sessionUuid: S2 };
    // A claim under the pre-fence binding is stale; under the fenced one the binding is not ready.
    expect((await registry.claimExecution(key, BINDING, owner)).kind).toBe("stale_binding");
    expect((await registry.claimExecution(key, FENCED, owner)).kind).toBe("binding_not_ready");

    work.active.delete(S1);
    await drain.whenIdle();

    expect(await registry.getAssignment(key)).toMatchObject({ ...FENCED, state: "ready" });
    expect(await drain.releaseExecution(S1)).toMatchObject({
      outcome: "reusable_for_this_binding",
      settlement: "confirmed",
      alreadyReleased: true,
    });
  });

  describe("with the binding journal (#11179)", () => {
    let inFlight: BindingJournalInFlight;

    beforeEach(() => {
      inFlight = new BindingJournalInFlight();
      drain.close();
      drain = new BrokerExecutionRelease({
        registry: async () => registry,
        journal: { inFlight },
        settler: SETTLER,
        work,
        sessions,
        timer,
        settlementCapMs: 1_000,
      });
    });

    test("an unsettled drain journals its settling mark and closes the entry when it settles", async () => {
      timer.enableAutoAdvance();
      work.endOnCancel = false;
      work.active.set(S1, 1);

      await drain.releaseExecution(S1);

      const [entry] = await registry.listOpenBindingJournal(key);
      expect(entry).toMatchObject({
        kind: "release",
        phase: "intent",
        owner: { daemonId: SETTLER.daemonId, pid: SETTLER.pid },
        fromGeneration: BINDING.generation,
        binding: FENCED,
        target: { oldStableId: AVD },
      });
      expect(inFlight.has(entry.id)).toBe(true);
      expect(await registry.getAssignment(key)).toMatchObject({
        ...FENCED,
        state: "settling",
        settler: SETTLER,
      });

      work.active.delete(S1);
      await drain.whenIdle();

      expect(await registry.getBindingJournal(entry.id)).toMatchObject({ phase: "committed" });
      expect(inFlight.has(entry.id)).toBe(false);
      expect(await registry.getAssignment(key)).toMatchObject({ ...FENCED, state: "ready" });
    });

    test("work that outlives the cap keeps its entry guarded, then settles it when the work ends (#11336)", async () => {
      timer.enableAutoAdvance();
      work.endOnCancel = false;
      work.active.set(S1, 1);
      await drain.releaseExecution(S1);
      const [entry] = await registry.listOpenBindingJournal(key);
      // The work finishes a minute after the 1 s cap; the watcher is still polling.
      timer.setTimeout(() => work.active.delete(S1), 1_000 + 60_000);
      let guardedPastCap: boolean | undefined;
      timer.setTimeout(() => (guardedPastCap = inFlight.has(entry.id)), 1_000 + 1_000);

      await drain.whenIdle();

      expect(guardedPastCap).toBe(true);
      expect(await registry.getBindingJournal(entry.id)).toMatchObject({ phase: "committed" });
      expect(inFlight.has(entry.id)).toBe(false);
      expect(await registry.getAssignment(key)).toMatchObject({ ...FENCED, state: "ready" });
    });

    test("a settled drain opens no journal entry", async () => {
      await drain.releaseExecution(S1);
      expect(await registry.listOpenBindingJournal()).toEqual([]);
    });
  });

  test("a release stuck past its budget is forced into quarantine and reported cleanup_pending", async () => {
    timer.enableAutoAdvance();
    sessions.hangRelease = true;

    const result = await drain.releaseExecution(S1);

    expect(result).toMatchObject({ outcome: "cleanup_pending", releaseForced: true });
    expect(sessions.forced).toEqual([S1]);
    expect(await registry.getAssignment(key)).toMatchObject({
      ...FENCED,
      state: "settling",
      settler: SETTLER,
      execOwner: null,
    });

    sessions.cleanupInProgress.delete(DEVICE);
    await drain.whenIdle();
    expect(await registry.getAssignment(key)).toMatchObject({ ...FENCED, state: "ready" });
  });

  describe("work that outlives the settlement cap (#11336)", () => {
    const CAP_MS = 1_000;
    const SLOW_POLL_MS = 30_000;

    beforeEach(() => {
      drain.close();
      drain = new BrokerExecutionRelease({
        registry: async () => registry,
        work,
        sessions,
        timer,
        settlementCapMs: CAP_MS,
        settlementSlowPollMs: SLOW_POLL_MS,
        settler: SETTLER,
      });
      timer.enableAutoAdvance();
      work.endOnCancel = false;
      work.active.set(S1, 1);
    });

    test("the binding returns to ready once the work settles, and can be claimed again", async () => {
      await drain.releaseExecution(S1);
      timer.setTimeout(() => work.active.delete(S1), CAP_MS + 60_000);
      let settlingPastCap: string | undefined;
      timer.setTimeout(() => {
        void registry.getAssignment(key).then((binding) => (settlingPastCap = binding?.state));
      }, CAP_MS + 1_000);

      await drain.whenIdle();

      expect(settlingPastCap).toBe("settling");
      expect(await registry.getAssignment(key)).toMatchObject({ ...FENCED, state: "ready" });
      const claimed = await registry.claimExecution(key, FENCED, {
        daemonId: SETTLER.daemonId,
        pid: SETTLER.pid,
        sessionUuid: S2,
      });
      expect(claimed.kind).toBe("claimed");
    });

    test("it warns once and re-checks at the slow cadence after the cap", async () => {
      await drain.releaseExecution(S1);
      const start = timer.now();
      const polls: number[] = [];
      const originalSleep = timer.sleep.bind(timer);
      spyOn(timer, "sleep").mockImplementation((ms: number) => {
        polls.push(ms);
        return originalSleep(ms);
      });
      timer.setTimeout(() => work.active.delete(S1), CAP_MS + 5 * SLOW_POLL_MS);

      await drain.whenIdle();

      expect(timer.now() - start).toBeGreaterThanOrEqual(CAP_MS + 5 * SLOW_POLL_MS);
      expect(polls.filter((ms) => ms === SLOW_POLL_MS).length).toBeGreaterThanOrEqual(4);
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes("did not settle")),
      ).toHaveLength(1);
    });

    test("work that never settles stays settling, its settler live, until close stops the watcher", async () => {
      await drain.releaseExecution(S1);
      timer.setTimeout(() => drain.close(), CAP_MS + 10 * SLOW_POLL_MS);

      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({
        state: "settling",
        settler: SETTLER,
      });
      expect(await drain.recoverSettledBindings()).toEqual([]);
    });
  });

  test("a settling binding is recovered once its settler is gone", async () => {
    drain = new BrokerExecutionRelease({
      registry: async () => registry,
      work,
      sessions,
      timer,
      settlementCapMs: 1_000,
      settler: SETTLER,
    });
    timer.enableAutoAdvance();
    work.endOnCancel = false;
    work.active.set(S1, 1);

    await drain.releaseExecution(S1);
    timer.setTimeout(() => drain.close(), 2_000);
    await drain.whenIdle();

    expect(await registry.getAssignment(key)).toMatchObject({
      state: "settling",
      settler: SETTLER,
    });
    // A closed coordinator leaves recovery to its successor, even while the settler is live.
    expect(await drain.recoverSettledBindings()).toEqual([]);
    drain = new BrokerExecutionRelease({ registry: async () => registry, work, sessions, timer });
    // A live settler keeps it; the successor recovers it once that settler is gone.
    expect(await drain.recoverSettledBindings()).toEqual([]);
    registry.setExecOwnerLiveness((owner) => owner.pid !== SETTLER.pid);
    expect((await drain.recoverSettledBindings()).map((binding) => binding.bindingIndex)).toEqual([
      0,
    ]);
    expect(await registry.getAssignment(key)).toMatchObject({
      ...FENCED,
      state: "ready",
      settler: null,
    });
  });

  test("repeated and concurrent releases converge without releasing twice", async () => {
    const [first, second] = await Promise.all([
      drain.releaseExecution(S1),
      drain.releaseExecution(S1),
    ]);
    expect(second).toBe(first);
    const again = await drain.releaseExecution(S1);

    expect(sessions.released).toEqual([S1]);
    expect(again).toMatchObject({
      outcome: "reusable_for_this_binding",
      alreadyReleased: true,
      cancellationRequested: 0,
    });
    expect(again.bindings).toEqual([
      expect.objectContaining({ stableDeviceId: AVD, state: "ready", execOwnerReleased: false }),
    ]);
  });

  test("a late release of S1 never releases the binding's fresh execution S2", async () => {
    await drain.releaseExecution(S1);
    await claim(S2);

    await drain.releaseExecution(S1);

    expect(sessions.live.has(S2)).toBe(true);
    expect(await registry.getAssignment(key)).toMatchObject({
      execOwner: expect.objectContaining({ sessionUuid: S2 }),
    });
  });

  test("an unknown session with no binding is reported released", async () => {
    expect(await drain.releaseExecution("never-issued")).toMatchObject({
      outcome: "reusable_for_this_binding",
      alreadyReleased: true,
      bindings: [],
    });
    expect(sessions.released).toEqual([]);
  });

  describe("releases that did not come through releaseExecution", () => {
    test("heartbeat loss / idle release of a managed session keeps the assignment", async () => {
      sessions.live.delete(S1);
      drain.onSessionReleased({
        sessionId: S1,
        deviceId: DEVICE,
        livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      });
      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({
        ...BINDING,
        state: "ready",
        execOwner: null,
      });
      expect(await registry.isDeviceAssignedToValidBinding("android", AVD)).toBe(true);
    });

    test("work still running at that release keeps the binding cleanup_pending until it settles", async () => {
      timer.enableAutoAdvance();
      work.active.set(S1, 1);
      sessions.live.delete(S1);
      drain.onSessionReleased({
        sessionId: S1,
        deviceId: DEVICE,
        livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      });
      await Promise.resolve();
      await timer.sleep(10);
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "settling",
        execOwner: null,
      });

      work.active.delete(S1);
      await drain.whenIdle();
      expect(await registry.getAssignment(key)).toMatchObject({
        ...FENCED,
        state: "ready",
        settler: null,
      });
    });

    test("non-managed sessions and terminal upgrades are ignored", async () => {
      drain.onSessionReleased({ sessionId: S1, deviceId: DEVICE });
      drain.onSessionReleased(
        { sessionId: S1, deviceId: DEVICE, livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY },
        { upgradeOnly: true },
      );
      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: expect.objectContaining({ sessionUuid: S1 }),
      });
    });
  });
});

describe("managed execution release wiring", () => {
  test("a managed session's release snapshot carries the marker the listener keys on", async () => {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    try {
      const policies: Array<string | undefined> = [];
      manager.onSessionRelease((_id, _device, _reason, snapshot) => {
        policies.push(snapshot.livenessPolicy);
      });
      await manager.createSession(S1, DEVICE, "android");
      await manager.adoptManagedExecutionLivenessPolicy(S1);
      await manager.createSession(S2, "emulator-5556", "android");

      await manager.releaseSession(S1);
      await manager.releaseSession(S2);

      expect(policies).toEqual([MANAGED_EXECUTION_LIVENESS_POLICY, undefined]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("session adapter exposes the report only after teardown", async () => {
    const report = {
      status: "restored_to_baseline" as const,
      settings: [{ setting: "svc_stayon" as const, value: "false" }],
    };
    const manager = new SessionManager(
      new FakeTimer(),
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => report }),
    );
    manager.stopCleanupTimer();
    try {
      await manager.createSession(S1, DEVICE, "android");
      manager.setKeepScreenAwake(S1, { applied: true });
      const sessions = managedExecutionSessionsFrom(manager, { releaseDevice: async () => {} });
      expect(sessions.getKeepAwakeRestoreReport?.(S1)).toBeUndefined();
      await sessions.releaseSession(S1);
      expect(sessions.getKeepAwakeRestoreReport?.(S1)).toEqual(report);
    } finally {
      manager.stopCleanupTimer();
    }
  });
});
