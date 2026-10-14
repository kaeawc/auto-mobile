import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ManagedSlotAcquisition } from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  type ManagedSlotReconcileRequest,
  type ManagedSlotReconcileResult,
} from "../../../src/daemon/managedSlots/reconciler";
import { SlotScopeReset } from "../../../src/daemon/managedSlots/slotScopeReset";
import { parseManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";
import type { SlotKey } from "../../../src/daemon/managedSlots/slotRegistry";

const SPEC_18 = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };
const TOKEN = "test-token";
function configFor(overrides: { runnerIncarnation?: string } = {}) {
  return parseManagedSlotConfig({
    contractVersion: 1,
    ...SCOPE,
    ...overrides,
    localSlotCapacity: 1,
    requests: [{ slotIndex: 0, role: "app", platform: "ios", requestedSpec: SPEC_18 }],
  });
}

describe("busy registry callers", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let reconciler: ManagedSlotReconciler;
  let acquisition: ManagedSlotAcquisition;
  let key: SlotKey;
  beforeEach(async () => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    registry = new FakeSlotRegistry(timer, () => false);
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    reconciler = new ManagedSlotReconciler({
      registry,
      inventory,
      provisioner,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      deleter: new FakeDeleter(inventory),
      claims: new FakeClaims(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
    });
    acquisition = new ManagedSlotAcquisition({
      registry: async () => registry,
      reconcile: (_registry, request) => reconciler.reconcile(request),
      timer,
      owner: () => ({ daemonId: "d", pid: 7 }),
      sessions: {
        claimLivenessOwnership: async () => "claimed",
        adoptManagedExecutionLivenessPolicy: async () => undefined,
        releaseSession: async () => undefined,
      },
    });
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  });
  function request(
    spec = SPEC_18,
    overrides: Partial<ManagedSlotReconcileRequest> = {},
  ): ManagedSlotReconcileRequest {
    return {
      key,
      role: "app",
      platform: "ios",
      requestedSpec: spec,
      deadlineMs: timer.now() + 60_000,
      ...overrides,
    };
  }
  async function seedAssigned(): Promise<string> {
    const result: ManagedSlotReconcileResult = await reconciler.reconcile(request());
    if (result.outcome !== "ready") {
      throw new Error("seed failed");
    }
    provisioner.calls.length = 0;
    return result.device.stableId;
  }
  test("busy scope admission returns a retryable refusal, then succeeds", async () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const ensure = spyOn(registry, "ensureScope").mockRejectedValueOnce(busy);
    try {
      const config = configFor();
      expect(await acquisition.acquire(config, { livenessOwnerToken: TOKEN })).toMatchObject({
        outcome: "failed",
        failure: { code: "discovery_incomplete", retryable: true },
        slots: [],
      });
      expect(await acquisition.acquire(config, { livenessOwnerToken: TOKEN })).toMatchObject({
        outcome: "ready",
      });
    } finally {
      ensure.mockRestore();
      acquisition.close();
    }
  });

  test.each(["ensureScope", "beginScopeInvalidation", "completeScopeInvalidation"] as const)(
    "busy incarnation transition %s refuses retryably, then resumes",
    async (method) => {
      await registry.ensureScope(configFor());
      const config = configFor({ runnerIncarnation: "inc-2" });
      const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const conflict = await registry.ensureScope(config);
      const write = spyOn(registry, method);
      if (method === "ensureScope") {
        write.mockResolvedValueOnce(conflict);
      }
      write.mockRejectedValueOnce(busy);
      try {
        expect(await acquisition.acquire(config, { livenessOwnerToken: TOKEN })).toMatchObject({
          outcome: "failed",
          failure: { code: "discovery_incomplete", retryable: true },
        });
        expect(await acquisition.acquire(config, { livenessOwnerToken: TOKEN })).toMatchObject({
          outcome: "ready",
        });
      } finally {
        write.mockRestore();
        acquisition.close();
      }
    },
  );

  test("busy slot initialization returns a retryable refusal, then succeeds", async () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const init = spyOn(registry, "initSlot").mockRejectedValueOnce(busy);
    try {
      expect(await reconciler.reconcile(request())).toMatchObject({
        outcome: "failed",
        failure: { code: "discovery_incomplete", retryable: true },
      });
      expect(await reconciler.reconcile(request())).toMatchObject({ outcome: "ready" });
    } finally {
      init.mockRestore();
    }
  });

  test.each(["openSlotJournal", "advanceSlotJournal", "claimExecution"] as const)(
    "busy create %s refuses retryably and releases any unpublished session",
    async (method) => {
      const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const write = spyOn(registry, method).mockRejectedValueOnce(busy);
      try {
        expect(
          await reconciler.reconcile(request(SPEC_18, { owner: { daemonId: "d", pid: 7 } })),
        ).toMatchObject({
          outcome: "failed",
          failure: { code: "discovery_incomplete", retryable: true },
        });
        if (method !== "openSlotJournal") {
          expect(provisioner.released).toEqual(["session-1"]);
        }
      } finally {
        write.mockRestore();
      }
      const retry = await reconciler.reconcile(
        request(SPEC_18, { owner: { daemonId: "d", pid: 7 } }),
      );
      expect(retry.outcome).toBe("ready");
      if (retry.outcome !== "ready") {
        throw new Error("retry failed");
      }
      expect(inventory.devices).toHaveLength(1);
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
      expect((await registry.getAssignment(key))?.execOwner?.sessionUuid).toBe(retry.sessionUuid);
    },
  );

  test.each(["readiness", "commit conflict"] as const)(
    "busy cleanup after %s keeps its typed failure and releases the session once",
    async (cause) => {
      const advance = registry.advanceSlotJournal.bind(registry);
      const write = spyOn(registry, "advanceSlotJournal").mockImplementationOnce(advance);
      if (cause === "readiness") {
        provisioner.readinessStatus = "booted";
      } else {
        write.mockResolvedValueOnce({ kind: "scope_not_valid", scope: null });
      }
      write.mockRejectedValueOnce(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      );
      try {
        const result = await reconciler.reconcile(request());
        expect(provisioner.released).toEqual(["session-1"]);
        expect(result).toMatchObject({
          outcome: "failed",
          failure: { code: cause === "readiness" ? "readiness_incomplete" : "scope_not_valid" },
        });
        // Readiness records the flag atomically: the injected busy write now hits rollback,
        // after native deletion. Commit refusal still retries its separate flag write.
        expect(await registry.listOpenSlotJournal(key)).toHaveLength(cause === "readiness" ? 1 : 0);
        expect(inventory.devices).toHaveLength(0);
      } finally {
        write.mockRestore();
      }
      provisioner.readinessStatus = "automation_ready";
      const retry = await reconciler.reconcile(
        request(SPEC_18, { owner: { daemonId: "d", pid: 7 } }),
      );
      expect(retry.outcome).toBe("ready");
      if (retry.outcome !== "ready") {
        throw new Error("retry failed");
      }
      expect(inventory.devices).toHaveLength(1);
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
      expect((await registry.getAssignment(key))?.execOwner?.sessionUuid).toBe(retry.sessionUuid);
    },
  );

  test.each(["readiness", "commit conflict"] as const)(
    "persistently busy cleanup after %s retains discard intent without adopting it",
    async (cause) => {
      const advance = registry.advanceSlotJournal.bind(registry);
      const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const write = spyOn(registry, "advanceSlotJournal")
        .mockRejectedValue(busy)
        .mockImplementationOnce(advance);
      if (cause === "readiness") {
        provisioner.readinessStatus = "booted";
      } else {
        write.mockResolvedValueOnce({ kind: "scope_not_valid", scope: null });
      }
      try {
        expect(await reconciler.reconcile(request())).toMatchObject({
          outcome: "failed",
          failure: { code: cause === "readiness" ? "readiness_incomplete" : "scope_not_valid" },
        });
        expect(provisioner.released).toEqual(["session-1"]);
        expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);
        expect(inventory.has("UDID-1")).toBe(cause !== "readiness");
      } finally {
        write.mockRestore();
      }
      provisioner.readinessStatus = "automation_ready";
      expect(await reconciler.reconcile(request())).toMatchObject({ outcome: "ready" });
      expect(inventory.has("UDID-1")).toBe(false);
      expect((await registry.getAssignment(key))?.stableDeviceId).not.toBe("UDID-1");
      expect(inventory.devices).toHaveLength(1);
      expect(await registry.listOpenSlotJournal(key)).toHaveLength(0);
      expect(provisioner.released).toEqual(["session-1"]);
    },
  );

  test.each(["updateSlotState", "commitBinding", "claimExecution"] as const)(
    "busy reuse %s releases the session before retryable refusal",
    async (method) => {
      const stableId = await seedAssigned();
      if (method === "commitBinding") {
        await registry.commitBinding(
          key,
          { generation: 1, stableDeviceId: stableId },
          {
            stableDeviceId: stableId,
            deviceName: inventory.devices[0]!.name,
            requestedSpec: SPEC_18,
            resolvedSpec: SPEC_18,
            specFingerprint: "stale",
            state: "ready",
          },
        );
      }
      const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const write = spyOn(registry, method).mockRejectedValueOnce(busy);
      try {
        expect(
          await reconciler.reconcile(
            request(
              SPEC_18,
              method === "claimExecution" ? { owner: { daemonId: "d", pid: 7 } } : {},
            ),
          ),
        ).toMatchObject({
          outcome: "failed",
          failure: { code: "discovery_incomplete", retryable: true },
        });
        // A reservation claim fails BEFORE provisioning; other busy publishes release session-2.
        expect(provisioner.released).toEqual(method === "claimExecution" ? [] : ["session-2"]);
      } finally {
        write.mockRestore();
      }
      expect(await reconciler.reconcile(request())).toMatchObject({ outcome: "ready" });
    },
  );

  test("busy final reuse claim clears its reservation and releases the unpublished session", async () => {
    await seedAssigned();
    const claim = registry.claimExecution.bind(registry);
    const write = spyOn(registry, "claimExecution")
      .mockImplementationOnce(claim)
      .mockRejectedValueOnce(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      );
    try {
      expect(
        await reconciler.reconcile(request(SPEC_18, { owner: { daemonId: "d", pid: 7 } })),
      ).toMatchObject({
        outcome: "failed",
        failure: { code: "discovery_incomplete", retryable: true },
      });
      expect(provisioner.released).toEqual(["session-2"]);
      expect((await registry.getAssignment(key))?.execOwner).toBeNull();
    } finally {
      write.mockRestore();
    }
    expect(await reconciler.reconcile(request())).toMatchObject({ outcome: "ready" });
  });

  test("busy group acquisition backs out the sessions it already handed out", async () => {
    const init = registry.initSlot.bind(registry);
    const write = spyOn(registry, "initSlot")
      .mockImplementationOnce(init)
      .mockRejectedValueOnce(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      );
    const config = configFor();
    config.requests.push({ ...config.requests[0]!, slotIndex: 1, role: "second" });
    try {
      expect(await acquisition.acquire(config, { livenessOwnerToken: TOKEN })).toMatchObject({
        outcome: "failed",
        failure: { code: "discovery_incomplete", retryable: true },
      });
      expect((await registry.getAssignment(key))?.execOwner).toBeNull();
    } finally {
      write.mockRestore();
      acquisition.close();
    }
  });

  test("busy settled-slot recovery is retryable and recovers on the next acquisition", async () => {
    const stableId = await seedAssigned();
    await registry.updateSlotState(key, { generation: 1, stableDeviceId: stableId }, "settling", {
      settler: { daemonId: "old", pid: 0 },
    });
    const recovery = spyOn(registry, "recoverSettledSlots").mockRejectedValueOnce(
      Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
    );
    try {
      expect(await reconciler.reconcile(request())).toMatchObject({
        outcome: "failed",
        failure: { code: "discovery_incomplete", retryable: true },
      });
    } finally {
      recovery.mockRestore();
    }
    expect(await reconciler.reconcile(request())).toMatchObject({ outcome: "ready" });
  });
});

describe("busy scope reset", () => {
  const RESET = { runnerNamespace: "runner-a", runnerIncarnation: "boot-1" };
  let registry: FakeSlotRegistry;
  let reset: SlotScopeReset;
  beforeEach(() => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    registry = new FakeSlotRegistry(timer, () => false);
    reset = new SlotScopeReset({
      registry: async () => registry,
      timer,
      isExecOwnerLive: () => false,
    });
  });
  test.each(["beginScopeInvalidation", "completeScopeInvalidation"] as const)(
    "busy %s refuses retryably and a repeated reset completes",
    async (method) => {
      await assignManagedSlotDevice(registry, "android", "avd-a", "runner-a");
      const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const write = spyOn(registry, method).mockRejectedValueOnce(busy);
      try {
        await expect(reset.reset(RESET)).rejects.toMatchObject({
          code: "discovery_incomplete",
          retryable: true,
        });
        expect(await reset.reset(RESET)).toMatchObject({
          outcome: "invalidated",
          retryable: false,
        });
      } finally {
        write.mockRestore();
      }
    },
  );
});
