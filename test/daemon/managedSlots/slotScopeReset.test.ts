import { beforeEach, describe, expect, test } from "bun:test";
import {
  SLOT_SCOPE_RESET_POLL_MS,
  SlotScopeReset,
} from "../../../src/daemon/managedSlots/slotScopeReset";
import { MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS } from "../../../src/daemon/managedSlots/slotRegistry";
import { DAEMON_RESET_SLOT_SCOPE_METHOD } from "../../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

// #11174 part c / Q2: `--daemon reset-slot-scope` invalidates only the named incarnation's scope,
// after its owners and cleanup settle (bounded), and moves its devices to the managed free pool.

const RESET = { runnerNamespace: "runner-a", runnerIncarnation: "boot-1" };

describe("SlotScopeReset", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let livePids: Set<number>;
  let reset: SlotScopeReset;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    timer.enableAutoAdvance();
    livePids = new Set();
    registry = new FakeSlotRegistry(timer, (owner) => livePids.has(owner.pid));
    reset = new SlotScopeReset({ registry: async () => registry, timer });
  });

  test("invalidates only the named scope and frees its devices; repeating is idempotent", async () => {
    const a = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
    const b = await assignManagedSlotDevice(registry, "android", "avd-b", "runner-b");

    const result = await reset.reset(RESET);

    expect(result).toMatchObject({
      outcome: "invalidated",
      retryable: false,
      scopes: [
        {
          scopeKey: a.scopeKey,
          outcome: "invalidated",
          freedDevices: [{ platform: "android", stableDeviceId: "avd-a" }],
        },
      ],
    });
    expect((await registry.listFreeDevices()).map((device) => device.stableDeviceId)).toEqual([
      "avd-a",
    ]);
    expect((await registry.getScope(b.scopeKey))?.state).toBe("valid");
    expect((await registry.getAssignment(b))?.stableDeviceId).toBe("avd-b");
    // An old-incarnation acquisition can no longer recreate the scope.
    expect((await registry.ensureScope({ managedHostScope: "host", ...RESET })).kind).toBe(
      "scope_invalidated",
    );

    expect(await reset.reset(RESET)).toMatchObject({
      outcome: "invalidated",
      scopes: [{ outcome: "already_invalidated", freedDevices: [] }],
    });
  });

  test("reports not_found for an unknown incarnation and a non-matching host scope", async () => {
    await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
    expect(await reset.reset({ ...RESET, runnerIncarnation: "boot-9" })).toEqual({
      outcome: "not_found",
      retryable: false,
      scopes: [],
      waitedMs: 0,
    });
    expect((await reset.reset({ ...RESET, managedHostScope: "other" })).outcome).toBe("not_found");
  });

  test("waits for a live owner to settle, then invalidates", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a", "s1");
    livePids.add(1);
    timer.setTimeout(() => livePids.delete(1), 3 * SLOT_SCOPE_RESET_POLL_MS);

    const result = await reset.reset({ ...RESET, waitMs: 5_000 });

    expect(result.outcome).toBe("invalidated");
    expect(result.waitedMs).toBeGreaterThanOrEqual(3 * SLOT_SCOPE_RESET_POLL_MS);
    expect((await registry.getScope(key.scopeKey))?.state).toBe("invalidated");
  });

  test("an unsettled scope stays blocked and is reported pending with what it waits on", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a", "s1");
    livePids.add(1);

    const result = await reset.reset({ ...RESET, waitMs: 1_000 });

    expect(result).toMatchObject({
      outcome: "pending",
      retryable: true,
      scopes: [
        {
          outcome: "pending",
          freedDevices: [],
          pending: {
            liveOwners: [{ slotIndex: 0, sessionUuid: "s1", pid: 1 }],
            cleanupPending: [],
          },
        },
      ],
    });
    // Acquisitions are blocked while it waits; the device stays assigned, not free.
    expect((await registry.getScope(key.scopeKey))?.state).toBe("invalidating");
    expect((await registry.ensureScope({ managedHostScope: "host", ...RESET })).kind).toBe(
      "scope_invalidated",
    );
    expect(await registry.listFreeDevices()).toEqual([]);

    // A retry after the owner is gone completes the same reset.
    livePids.delete(1);
    expect((await reset.reset({ ...RESET, waitMs: 0 })).outcome).toBe("invalidated");
  });

  test("pending cleanup also blocks the reset", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
    await registry.updateSlotState(
      key,
      { generation: 1, stableDeviceId: "avd-a" },
      "cleanup_pending",
    );

    const result = await reset.reset({ ...RESET, waitMs: 0 });

    expect(result.scopes[0]?.pending?.cleanupPending).toEqual([
      { slotIndex: 0, platform: "android", stableDeviceId: "avd-a" },
    ]);
  });

  test("a slot still settling under a live settler blocks the reset until it settles", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
    livePids.add(7);
    const settled = await registry.updateSlotState(
      key,
      { generation: 1, stableDeviceId: "avd-a" },
      "settling",
      { settler: { daemonId: "d", pid: 7, processGenerationToken: "t" } },
    );
    expect(settled.kind).toBe("updated");

    const result = await reset.reset({ ...RESET, waitMs: 0 });
    expect(result.scopes[0]?.pending?.settling).toEqual([
      { slotIndex: 0, platform: "android", stableDeviceId: "avd-a" },
    ]);

    // A dead settler's work died with it: the slot no longer blocks.
    livePids.delete(7);
    expect((await reset.reset({ ...RESET, waitMs: 0 })).outcome).toBe("invalidated");
  });

  test("open journaled work blocks the reset and is reported", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
    const opened = await registry.openSlotJournal(key, {
      kind: "replace",
      phase: "deleting",
      target: {
        oldStableId: "avd-a",
        oldName: "avd-a",
        newName: null,
        newStableId: null,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
      },
      owner: { daemonId: "d", pid: 8, processGenerationToken: "t" },
      assignment: {
        kind: "state",
        expected: { generation: 1, stableDeviceId: "avd-a" },
        state: "replacing",
      },
    });
    expect(opened.kind).toBe("opened");

    const result = await reset.reset({ ...RESET, waitMs: 0 });

    expect(result).toMatchObject({
      outcome: "pending",
      scopes: [
        { pending: { openJournal: [{ slotIndex: 0, kind: "replace", phase: "deleting" }] } },
      ],
    });
    expect(await registry.listFreeDevices()).toEqual([]);
  });

  test("a reset makes an abandoned scope permanent instead of revivable", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
    await registry.markScopeAbandoned(key.scopeKey);

    expect((await reset.reset(RESET)).outcome).toBe("invalidated");
    expect((await registry.getScope(key.scopeKey))?.invalidationReason).toBe("operator_reset");
    expect((await registry.ensureScope({ managedHostScope: "host", ...RESET })).kind).toBe(
      "scope_invalidated",
    );
  });

  test("resetSupersededScope records incarnation_reset", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
    const scope = await registry.getScope(key.scopeKey);
    const result = await reset.resetSupersededScope(scope!);
    expect(result.outcome).toBe("invalidated");
    expect((await registry.getScope(key.scopeKey))?.invalidationReason).toBe("incarnation_reset");
  });

  test("daemon/resetSlotScope validates params, needs the service, and returns its result", async () => {
    const manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
    let available = false;
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
      getSlotScopeReset: () => (available ? reset : undefined),
    };
    const request = (params: Record<string, unknown>) =>
      handleDaemonRequest(
        { id: "r", type: "daemon_request", method: DAEMON_RESET_SLOT_SCOPE_METHOD, params },
        state,
      );
    try {
      await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
      expect(await request({ runnerNamespace: "runner-a" })).toMatchObject({ success: false });
      expect(await request({ ...RESET, waitMs: 120_000 })).toMatchObject({ success: false });
      expect(await request({ ...RESET, extra: 1 })).toMatchObject({ success: false });
      expect(await request(RESET)).toMatchObject({
        success: false,
        error: expect.stringContaining("not available"),
      });
      available = true;
      expect(await request({ ...RESET, waitMs: 0 })).toMatchObject({
        success: true,
        result: {
          outcome: "invalidated",
          scopes: [{ freedDevices: [{ stableDeviceId: "avd-a" }] }],
        },
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });
});
