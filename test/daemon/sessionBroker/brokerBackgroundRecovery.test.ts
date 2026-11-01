import { InMemoryMutationRecordingGaps } from "../../../src/daemon/sessionBroker/mutations/recordingGaps";
import { logger } from "../../../src/utils/logger";
import { SessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { openSessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import {
  SESSION_BROKER_SCOPE,
  parseSessionBrokerHostConfig,
} from "../../../src/daemon/sessionBroker/hostConfig";
import type { BrokerResourceRecord } from "../../../src/daemon/sessionBroker/store";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { drainMicrotasks, drainUntil, drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";

function config(requestId: string): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

// A cooperative port models the journal's shutdown cancellation. Pass deadlines do not abort it.
class BlockedPort extends FakeNativePort {
  readonly started: string[] = [];
  readonly pending = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  active = 0;
  peak = 0;
  override async destroy(
    resource: BrokerResourceRecord,
    signal?: AbortSignal,
  ): Promise<"absent" | "pending"> {
    this.started.push(resource.resourceId);
    const blocked = this.pending.get(resource.resourceId);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    const abort = () => blocked?.reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await blocked?.promise;
      signal?.throwIfAborted();
      return await super.destroy(resource);
    } finally {
      this.active--;
      signal?.removeEventListener("abort", abort);
    }
  }
}

describe("broker background recovery", () => {
  const restores: Array<() => void> = [];
  let registry: SqliteBindingRegistry;
  let timer: FakeTimer;
  let devices: BlockedPort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;
  const fixtures: Map<
    number,
    {
      registry: SqliteBindingRegistry;
      timer: FakeTimer;
      devices: BlockedPort;
      options: SessionBrokerOptions;
      broker: SessionBroker;
      receipts: Map<string, { resourceId: string; sessionId: string }>;
    }
  > = new Map();
  let receipts: Map<string, { resourceId: string; sessionId: string }>;
  beforeAll(async () => {
    // Build independent in-memory worlds outside the per-test budget; each test measures
    // recovery, not SQLite migrations or the unrelated acquisition setup.
    const seeds: Array<Array<[string, boolean]>> = [
      [["dead", false]],
      [["dead", false]],
      Array.from({ length: 5 }, (_, i) => [`request-${i}`, true]),
      [
        ["a", true],
        ["b", true],
        ["c", true],
      ],
      [
        ["a", true],
        ["b", true],
      ],
      [["expired", false]],
      [["abandoned", false]],
      [],
    ];
    for (const [fixtureIndex, entries] of seeds.entries()) {
      timer = new FakeTimer();
      registry = await openSqliteBindingRegistry({
        dbPath: ":memory:",
        timer,
        isExecOwnerLive: () => false,
      });
      const scope = await registry.ensureScope(SESSION_BROKER_SCOPE);
      if (scope.kind !== "ready") {
        throw new Error("missing scope");
      }
      devices = new BlockedPort(registry);
      options = {
        store: registry.sessionBrokerStore(
          scope.scope.scopeKey,
          new CountingIdGenerator("resource"),
        ),
        devices,
        owner: FAKE_BROKER_OWNER,
        limits: { totalDeviceCap: 8, sessionCap: 8, idlePoolCap: 0 },
        catalog: async () => iosCatalog(),
        defaults: () => iosDefaults(),
        timer,
        cleanupConcurrency: 2,
        cleanupWaitMs: 50,
      };
      broker = new SessionBroker(options);
      receipts = new Map();
      for (const [id, fail] of entries) {
        const ready = await broker.prepare(config(id), "owner");
        const request = await options.store.getRequest(id);
        if (!request?.resourceId || !ready.sessionUuid) {
          throw new Error("missing seeded resource");
        }
        if (fail) {
          await options.store.fail(id, FAKE_BROKER_OWNER, "interrupted");
        }
        receipts.set(id, { resourceId: request.resourceId, sessionId: ready.sessionUuid });
      }
      fixtures.set(fixtureIndex, { registry, timer, devices, options, broker, receipts });
    }
  });
  function useFixture(index: number): void {
    const fixture = fixtures.get(index);
    if (!fixture) {
      throw new Error("missing isolated recovery fixture");
    }
    fixtures.delete(index);
    ({ registry, timer, devices, options, broker, receipts } = fixture);
  }
  afterAll(async () => {
    for (const fixture of fixtures.values()) {
      await fixture.broker.close();
      await fixture.registry.close();
    }
  });
  afterEach(async () => {
    for (const blocked of devices.pending.values()) {
      blocked.resolve();
    }
    await broker.close();
    await registry.close();
    for (const restore of restores.splice(0)) {
      restore();
    }
  });
  function orphan(id: string) {
    const receipt = receipts.get(id);
    if (!receipt) {
      throw new Error(`missing seeded receipt ${id}`);
    }
    return receipt;
  }
  function block(id: string) {
    const pending = Promise.withResolvers<void>();
    devices.pending.set(id, pending);
    return pending;
  }

  test("startup commits a dead-owner receipt before returning and defers blocked destruction", async () => {
    useFixture(0);
    const a = orphan("dead");
    const resource = (await options.store.listResources())[0]!;
    const key = { scopeKey: resource.scopeKey, bindingIndex: resource.allocationIndex };
    const assignment = await registry.getAssignment(key);
    if (!assignment?.stableDeviceId) {
      throw new Error("missing binding");
    }
    await registry.openBindingJournal(key, {
      kind: "replace",
      phase: "deleting",
      owner: FAKE_BROKER_OWNER,
      target: {
        oldStableId: assignment.stableDeviceId,
        oldName: assignment.deviceName,
        newName: null,
        newStableId: null,
        requestedSpec: assignment.requestedSpec,
        resolvedSpec: assignment.resolvedSpec,
        specFingerprint: assignment.specFingerprint,
      },
      assignment: { kind: "state", expected: assignment, state: "replacing" },
    });
    const blocked = Promise.withResolvers<void>();
    let nativeStarted = false;
    const opening = openSessionBrokerService({
      deferStart: true,
      config: parseSessionBrokerHostConfig({
        contractVersion: 1,
        limits: { totalDeviceCap: 1 },
        defaults: { ios: iosDefaults() },
      }),
      registry,
      owner: { ...FAKE_BROKER_OWNER, daemonId: "successor", pid: 202 },
      timer,
      hostLock: { acquire: () => {}, release: () => {} },
      sessionDisposition: () => "gone",
      catalog: async () => iosCatalog(),
      acquisition: {
        acquire: async () => {
          throw new Error("unexpected acquisition");
        },
      },
      release: {
        releaseExecution: async () => {
          throw new Error("unexpected release");
        },
      },
      journal: {
        owner: FAKE_BROKER_OWNER,
        redriveBinding: async () => {
          nativeStarted = true;
          await blocked.promise;
          return { kind: "clear", redriven: [] };
        },
      },
    });
    let opened = false;
    void opening.then(() => {
      opened = true;
    });
    await drainUntil(() => opened || nativeStarted, { description: "startup recovery outcome" });
    // Release the gate even on old code so a failing assertion leaves no native work behind.
    const returnedBeforeCleanup = opened;
    blocked.resolve();
    const service = await opening;
    try {
      expect(returnedBeforeCleanup).toBe(true);
      expect(nativeStarted).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(await options.store.getRequest("dead")).toMatchObject({
        state: "failed",
        errorCode: "session_owner_exited",
      });
      expect((await options.store.listResources())[0]).toMatchObject({
        resourceId: a.resourceId,
        state: "destroying",
      });
      service.start();
      await drainUntil(() => nativeStarted, { description: "immediate native recovery" });
    } finally {
      await service.close();
    }
  });

  test("receipts-only recovery preserves cap occupancy until background destruction", async () => {
    useFixture(1);
    const a = orphan("dead");
    const pending = block(a.resourceId);
    broker = new SessionBroker({
      ...options,
      owner: { ...FAKE_BROKER_OWNER, daemonId: "next", pid: 202 },
      limits: { totalDeviceCap: 1 },
    });
    await broker.recoverReceipts();
    expect(await options.store.getRequest("dead")).toMatchObject({
      state: "failed",
      errorCode: "session_owner_exited",
    });
    expect(devices.started).toEqual([]);
    expect(await broker.prepare(config("new"), "owner")).toMatchObject({
      outcome: "failed",
      failure: { code: "capacity_exhausted" },
    });
    const pass = broker.recoverCleanup();
    await drainUntil(() => devices.started.length === 1, { description: "background destruction" });
    expect(devices.started).toEqual([a.resourceId]);
    pending.resolve();
    await pass;
    expect(devices.destroyed).toEqual([a.resourceId]);
  });

  test("a blocked A does not delay B or later items, and real concurrency stays bounded", async () => {
    useFixture(2);
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(orphan(`request-${i}`));
    }
    const a = entries[0]!;
    const pending = block(a.resourceId);
    const pass = broker.recover();
    try {
      await drainUntil(() => devices.destroyed.length === 4, {
        description: "all unblocked peers destroyed",
        maxTurns: 5000,
      });
      expect(devices.destroyed).toEqual(entries.slice(1).map((entry) => entry.resourceId));
      expect(devices.peak).toBe(2);
    } catch (error) {
      pending.resolve();
      await pass;
      throw error;
    }
    timer.advanceTime(50);
    await pass;
    await broker.recoverCleanup();
    expect(devices.started.filter((id) => id === a.resourceId)).toHaveLength(1);
    pending.reject(new Error("native failure"));
    await drainUntil(() => devices.active === 0, { description: "failed native destruction" });
    await drainUntilQuiescent(timer, { description: "failed cleanup settlement" });
    devices.pending.delete(a.resourceId);
    await broker.recoverCleanup();
    expect(devices.started.filter((id) => id === a.resourceId)).toHaveLength(2);
    expect(devices.peak).toBeLessThanOrEqual(2);
  });

  test("multiple blocked items retain slots across overlapping and later passes", async () => {
    useFixture(3);
    const a = orphan("a");
    const b = orphan("b");
    const c = orphan("c");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(() => warning.mockRestore());
    const first = block(a.resourceId);
    const second = block(b.resourceId);
    const pass = broker.recoverCleanup();
    await drainUntil(() => devices.started.length === 2, {
      description: "both cleanup slots held",
    });
    await broker.recoverCleanup();
    expect(
      warning.mock.calls.filter(
        ([message]) => message === "recovery cleanup slots saturated, 1 items deferred",
      ),
    ).toHaveLength(1);
    expect(devices.started).toEqual([a.resourceId, b.resourceId]);
    timer.advanceTime(50);
    await pass;
    await broker.recoverCleanup();
    expect(devices.started).toEqual([a.resourceId, b.resourceId]);
    first.resolve();
    await drainUntil(() => devices.active === 1, { description: "first native slot released" });
    await drainUntilQuiescent(timer, { description: "first cleanup settlement" });
    await broker.recoverCleanup();
    expect(devices.destroyed).toContain(c.resourceId);
    expect(devices.peak).toBe(2);
    second.resolve();
  });

  test("handoff aborts and close joins cleanup, with no starts or broker writes after close", async () => {
    useFixture(4);
    options.cleanupConcurrency = 1;
    broker = new SessionBroker(options);
    const a = orphan("a");
    orphan("b");
    block(a.resourceId);
    const pass = broker.recoverCleanup();
    await drainUntil(() => devices.started.length === 1, { description: "cleanup before close" });
    await broker.close();
    await pass;
    expect(devices.active).toBe(0);
    expect(devices.started).toEqual([a.resourceId]);
    const rows = await options.store.listResources();
    await broker.recover();
    await broker.recoverCleanup();
    expect(await options.store.listResources()).toEqual(rows);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("expired owned sessions commit releasing before a background drain; close joins the drain", async () => {
    useFixture(5);
    const a = orphan("expired");
    options.sessionDisposition = () => "gone";
    broker = new SessionBroker(options);
    const drain = Promise.withResolvers<void>();
    devices.releaseHook = () => drain.promise;
    await broker.recoverReceipts();
    expect(await options.store.getRequest("expired")).toMatchObject({ state: "releasing" });
    expect(devices.released).toEqual([]);
    const pass = broker.recoverCleanup();
    await drainUntil(() => devices.released.length === 1, { description: "expired session drain" });
    expect(devices.released).toEqual([a.sessionId]);
    let closed = false;
    const closing = broker.close().then(() => {
      closed = true;
    });
    // Closing is intentionally parked on an unresolved native drain with no timer signal.
    await drainMicrotasks(20);
    expect(closed).toBe(false);
    drain.resolve();
    await closing;
    await pass;
    expect(devices.destroyed).toEqual([]);
    expect(devices.resetResources).toEqual([]);
  });

  test("abandoned sessions drain once before destruction and full recover remains usable", async () => {
    useFixture(6);
    const a = orphan("abandoned");
    await options.store.abandon("abandoned", FAKE_BROKER_OWNER, "owner");
    const drain = Promise.withResolvers<void>();
    devices.releaseHook = () => drain.promise;
    const release = spyOn(devices, "release");
    await broker.recoverReceipts();
    expect(release).not.toHaveBeenCalled();
    const pass = broker.recoverCleanup();
    await drainUntil(() => devices.released.length === 1, {
      description: "abandoned session drain",
    });
    expect(devices.released).toEqual([a.sessionId]);
    await broker.recoverCleanup();
    expect(devices.released).toEqual([a.sessionId]);
    drain.resolve();
    await pass;
    devices.releaseHook = undefined;
    await broker.recover();
    expect(devices.destroyed).toContain(a.resourceId);
  });
  test("a cleanup-pass failure logs and the next loop pass still runs", async () => {
    useFixture(7);
    const receiptsPass = spyOn(broker, "recoverReceipts").mockResolvedValue(undefined);
    const failure = new Error("cleanup snapshot unavailable");
    const cleanup = spyOn(broker, "recoverCleanup")
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const service = new SessionBrokerService(
      broker,
      "scope",
      { acquire: () => {}, release: () => {} },
      { timer, mutations: { recordingGaps: new InMemoryMutationRecordingGaps() } },
    );
    try {
      service.start();
      await drainUntil(() => timer.getPendingTimeouts().includes(5_000), {
        description: "failed recovery pass parked for retry",
      });
      await timer.advanceTimeAsync(5_000);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith(
        "Session broker recovery remains pending: cleanup snapshot unavailable",
      );
    } finally {
      await service.close();
      receiptsPass.mockRestore();
      cleanup.mockRestore();
      warning.mockRestore();
    }
  });
});
