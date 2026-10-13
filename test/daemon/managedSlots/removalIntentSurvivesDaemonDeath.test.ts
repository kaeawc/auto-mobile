import { expect, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
} from "../../../src/daemon/managedSlots/reconciler";
import {
  ManagedSlotJournal,
  SlotJournalInFlight,
} from "../../../src/daemon/managedSlots/slotJournal";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
const OWNER = { daemonId: "first", pid: 101, processGenerationToken: "first" };
const NEXT = { daemonId: "next", pid: 102, processGenerationToken: "next" };

async function harness(ready = false) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const registry = new FakeSlotRegistry(timer, () => false);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  provisioner.readinessStatus = ready ? "automation_ready" : "booted";
  const deleter = new FakeDeleter(inventory);
  const claims = new FakeClaims();
  const matcher = new FakeMatcher();
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "removal",
    runnerIncarnation: "boot",
  });
  if (scope.kind !== "ready") {
    throw new Error(scope.kind);
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  const journal = (owner = OWNER) =>
    new ManagedSlotJournal({
      registry,
      inventory,
      deleter,
      claims,
      matcher,
      timer,
      owner,
      isOwnerLive: () => false,
      backoff: 10,
      inFlight: new SlotJournalInFlight(),
    });
  const reconciler = new ManagedSlotReconciler({
    registry,
    inventory,
    deleter,
    claims,
    matcher,
    timer,
    provisioner,
    resolver: new DefaultManagedSpecResolver(),
    journal: { owner: OWNER, isOwnerLive: () => false, backoff: 10 },
  });
  const driver = reconciler.journal;
  const request = {
    key,
    role: "app",
    platform: "ios" as const,
    requestedSpec: SPEC,
    deadlineMs: 11000,
    owner: OWNER,
  };
  return {
    timer,
    registry,
    inventory,
    provisioner,
    deleter,
    key,
    driver,
    reconciler,
    request,
    journal,
  };
}

async function assertRemovedByNext(h: Awaited<ReturnType<typeof harness>>) {
  h.deleter.beforeDelete = undefined;
  h.deleter.failWith = undefined;
  h.timer.advanceTime(10);
  expect(await h.journal(NEXT).redriveSlot(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  expect(h.inventory.devices).toEqual([]);
  expect((await h.registry.getSlotJournal(1))?.phase).toBe("rolled_back");
}

test("not-ready identity and removal flag are atomic before release or daemon death", async () => {
  const h = await harness();
  const advance = h.registry.advanceSlotJournal.bind(h.registry);
  let recorded = false;
  const dead = Promise.withResolvers<never>();
  h.registry.advanceSlotJournal = async (id, input) => {
    const result = await advance(id, input);
    if (input.phase === "created") {
      recorded = true;
      return dead.promise;
    }
    return result;
  };
  void h.reconciler.reconcile(h.request);
  await drainUntil(() => recorded, { description: "created write" });
  expect(await h.registry.getSlotJournal(1)).toMatchObject({
    phase: "created",
    target: { newStableId: "UDID-1", removalRequested: true },
  });
  expect(h.provisioner.released).toEqual([]);
  expect(h.deleter.calls).toEqual([]);
  h.registry.advanceSlotJournal = advance;
  await assertRemovedByNext(h);
});

test.each([false, true])(
  "intent is durable before release (commit refused: %s)",
  async (commitRefused) => {
    const h = await harness(commitRefused);
    const advance = h.registry.advanceSlotJournal.bind(h.registry);
    h.registry.advanceSlotJournal = async (id, input) =>
      input.phase === "committed"
        ? { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! }
        : advance(id, input);
    let releasing = false;
    h.provisioner.releaseSession = async () => {
      expect((await h.registry.getSlotJournal(1))?.target.removalRequested).toBe(true);
      releasing = true;
      return new Promise<void>(() => {});
    };
    void h.reconciler.reconcile(h.request);
    await drainUntil(() => releasing, { description: "durable intent before release" });
    h.registry.advanceSlotJournal = advance;
    await assertRemovedByNext(h);
  },
);

test("an expired commit refusal still attempts the flag write before release", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceSlotJournal.bind(h.registry);
  const order: string[] = [];
  h.registry.advanceSlotJournal = async (id, input) => {
    if (input.phase === "committed") {
      h.timer.setCurrentTime(h.request.deadlineMs + 1);
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    }
    if (input.target?.removalRequested) {
      order.push("flag");
    }
    return advance(id, input);
  };
  h.provisioner.releaseSession = async () => {
    order.push("release");
  };
  expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
  expect(order.slice(0, 2)).toEqual(["flag", "release"]);
  expect((await h.registry.getSlotJournal(1))?.target.removalRequested).toBe(true);
  await assertRemovedByNext(h);
});

test("busy created write fails, releases, and keeps this daemon from adopting", async () => {
  const h = await harness();
  const advance = h.registry.advanceSlotJournal.bind(h.registry);
  h.registry.advanceSlotJournal = async (id, input) => {
    if (input.phase === "created") {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return advance(id, input);
  };
  expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
  expect(h.provisioner.released).toEqual(["session-1"]);
  expect((await h.registry.getSlotJournal(1))?.target.removalRequested).toBeUndefined();
  h.registry.advanceSlotJournal = advance;
  expect(await h.driver.redriveSlot(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
});

test.each(["release", "failed-delete", "hung-delete"] as const)(
  "death after %s never permits adoption",
  async (step) => {
    const h = await harness();
    let stopped = false;
    if (step === "release") {
      const release = h.provisioner.releaseSession.bind(h.provisioner);
      h.provisioner.releaseSession = async (session) => {
        await release(session);
        stopped = true;
        return new Promise<void>(() => {});
      };
    } else if (step === "hung-delete") {
      h.deleter.beforeDelete = async () => {
        stopped = true;
        return new Promise<void>(() => {});
      };
    } else {
      h.deleter.failWith = "native failed";
    }
    const first = h.reconciler.reconcile(h.request);
    if (step === "failed-delete") {
      expect(await first).toMatchObject({
        outcome: "failed",
        failure: { code: "readiness_incomplete" },
      });
    } else {
      await drainUntil(() => stopped, { description: step });
    }
    expect((await h.registry.getSlotJournal(1))?.target.removalRequested).toBe(true);
    await assertRemovedByNext(h);
  },
);

test("successful commit survives death without deleting the bound device", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceSlotJournal.bind(h.registry);
  let committed = false;
  h.registry.advanceSlotJournal = async (id, input) => {
    const result = await advance(id, input);
    if (input.phase === "committed") {
      committed = true;
      return new Promise<never>(() => {});
    }
    return result;
  };
  void h.reconciler.reconcile(h.request);
  await drainUntil(() => committed, { description: "commit" });
  expect(await h.journal(NEXT).redriveSlot(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBe("UDID-1");
  expect(h.inventory.has("UDID-1")).toBe(true);
  expect(h.deleter.calls).toEqual([]);
});

test("a device not created by this attempt is rolled back without flag or delete", async () => {
  const h = await harness();
  const provision = h.provisioner.provision.bind(h.provisioner);
  h.provisioner.provision = async (request) => ({ ...(await provision(request)), created: false });
  expect(await h.reconciler.reconcile(h.request)).toMatchObject({
    outcome: "failed",
    failure: { code: "readiness_incomplete" },
  });
  expect(await h.registry.getSlotJournal(1)).toMatchObject({ phase: "rolled_back" });
  expect((await h.registry.getSlotJournal(1))?.target.removalRequested).toBeUndefined();
  expect(h.deleter.calls).toEqual([]);
  expect(h.inventory.has("UDID-1")).toBe(true);
});

test.each(["slot", "free"] as const)(
  "discard preserves a device held by a winning %s",
  async (holder) => {
    const h = await harness(true);
    const advance = h.registry.advanceSlotJournal.bind(h.registry);
    h.registry.advanceSlotJournal = async (id, input) => {
      if (input.phase !== "committed") {
        return advance(id, input);
      }
      const assignment = (await h.registry.getAssignment(h.key))!;
      if (holder === "slot") {
        await h.registry.commitBinding(
          h.key,
          { generation: assignment.generation, stableDeviceId: null },
          {
            stableDeviceId: "UDID-1",
            deviceName: h.inventory.devices[0].name,
            resolvedSpec: SPEC,
            specFingerprint: "winner",
            state: "ready",
          },
        );
      } else {
        const scope = await h.registry.getScope(h.key.scopeKey);
        if (!scope) {
          throw new Error("missing scope");
        }
        h.registry.findDeviceHolder = async () => ({
          kind: "free",
          device: {
            platform: "ios",
            stableDeviceId: "UDID-1",
            fromScopeKey: scope.scopeKey,
            specFingerprint: "winner",
            freedAtMs: h.timer.now(),
            state: "free",
            deletion: null,
            stopClaimedBy: null,
            stopClaimedAtMs: null,
          },
        });
      }
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    };
    expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
    expect((await h.registry.getSlotJournal(1))?.phase).toBe("rolled_back");
    expect(h.inventory.has("UDID-1")).toBe(true);
    expect(h.deleter.calls).toEqual([]);
  },
);

test("a busy flag at the expired deadline releases and preserves the refusal and memory fence", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceSlotJournal.bind(h.registry);
  let flags = 0;
  h.registry.advanceSlotJournal = async (id, input) => {
    if (input.phase === "committed") {
      h.timer.setCurrentTime(h.request.deadlineMs + 1);
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    }
    if (input.target?.removalRequested) {
      flags++;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return advance(id, input);
  };
  expect(await h.reconciler.reconcile(h.request)).toMatchObject({
    outcome: "failed",
    failure: { code: "concurrent_modification" },
  });
  expect(flags).toBe(1);
  expect(h.provisioner.released).toEqual(["session-1"]);
  h.registry.advanceSlotJournal = advance;
  h.timer.advanceTime(10);
  expect(await h.driver.redriveSlot(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
});

test.each(["created", "flag"] as const)(
  "non-retryable %s write failures still release the session and fail",
  async (write) => {
    const h = await harness(write === "flag");
    const advance = h.registry.advanceSlotJournal.bind(h.registry);
    h.registry.advanceSlotJournal = async (id, input) => {
      if (
        (write === "created" && input.phase === "created") ||
        (write === "flag" && input.target?.removalRequested)
      ) {
        throw new Error("registry unavailable");
      }
      if (input.phase === "committed") {
        return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
      }
      return advance(id, input);
    };
    await expect(h.reconciler.reconcile(h.request)).rejects.toThrow("registry unavailable");
    expect(h.provisioner.released).toEqual(["session-1"]);
    h.registry.advanceSlotJournal = advance;
    expect(await h.driver.redriveSlot(h.key)).toMatchObject({ kind: "clear" });
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
  },
);

test("created journal conflict clears the losing driver's memory intent", async () => {
  const h = await harness();
  const advance = h.registry.advanceSlotJournal.bind(h.registry);
  h.registry.advanceSlotJournal = async (id, input) => {
    if (input.phase !== "created") {
      return advance(id, input);
    }
    await advance(id, {
      ...input,
      target: { newStableId: "UDID-1", newName: h.inventory.devices[0].name },
    });
    return { kind: "journal_conflict", entry: (await h.registry.getSlotJournal(id))! };
  };
  expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
  h.registry.advanceSlotJournal = advance;
  expect(await h.driver.redriveSlot(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getSlotJournal(1))?.phase).toBe("committed");
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBe("UDID-1");
  expect(h.deleter.calls).toEqual([]);
});
