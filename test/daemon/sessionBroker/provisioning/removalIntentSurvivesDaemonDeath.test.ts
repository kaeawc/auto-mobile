import { expect, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  BindingReconciler,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import {
  BindingJournal,
  BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS,
  BindingJournalInFlight,
  BindingJournalRemovalRegistryTimeout,
} from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../../helpers/fakeTimerStepping";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

const SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
const OWNER = { daemonId: "first", pid: 101, processGenerationToken: "first" };
const NEXT = { daemonId: "next", pid: 102, processGenerationToken: "next" };

async function harness(ready = false) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const registry = new FakeBindingRegistry(timer, () => false);
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
  const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  const journal = (owner = OWNER) =>
    new BindingJournal({
      registry,
      inventory,
      deleter,
      claims,
      matcher,
      timer,
      owner,
      isOwnerLive: () => false,
      backoff: 10,
      inFlight: new BindingJournalInFlight(),
    });
  const reconciler = new BindingReconciler({
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
  expect(await h.journal(NEXT).redriveBinding(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  expect(h.inventory.devices).toEqual([]);
  expect((await h.registry.getBindingJournal(1))?.phase).toBe("rolled_back");
}

test("not-ready identity and removal flag are atomic before release or daemon death", async () => {
  const h = await harness();
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  let recorded = false;
  const dead = Promise.withResolvers<never>();
  h.registry.advanceBindingJournal = async (id, input) => {
    const result = await advance(id, input);
    if (input.phase === "created") {
      recorded = true;
      return dead.promise;
    }
    return result;
  };
  void h.reconciler.reconcile(h.request);
  await drainUntil(() => recorded, { description: "created write" });
  expect(await h.registry.getBindingJournal(1)).toMatchObject({
    phase: "created",
    target: { newStableId: "UDID-1", removalRequested: true },
  });
  expect(h.provisioner.released).toEqual([]);
  expect(h.deleter.calls).toEqual([]);
  h.registry.advanceBindingJournal = advance;
  await assertRemovedByNext(h);
});

test.each([false, true])(
  "intent is durable before release (commit refused: %s)",
  async (commitRefused) => {
    const h = await harness(commitRefused);
    const advance = h.registry.advanceBindingJournal.bind(h.registry);
    h.registry.advanceBindingJournal = async (id, input) =>
      input.phase === "committed"
        ? { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! }
        : advance(id, input);
    let releasing = false;
    h.provisioner.releaseSession = async () => {
      expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBe(true);
      releasing = true;
      return new Promise<void>(() => {});
    };
    void h.reconciler.reconcile(h.request);
    await drainUntil(() => releasing, { description: "durable intent before release" });
    h.registry.advanceBindingJournal = advance;
    await assertRemovedByNext(h);
  },
);

test("an expired commit refusal still attempts the flag write before release", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  const order: string[] = [];
  h.registry.advanceBindingJournal = async (id, input) => {
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
  expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBe(true);
  await assertRemovedByNext(h);
});

test("an already-aborted commit refusal writes the flag before release", async () => {
  const h = await harness(true);
  const controller = new AbortController();
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  const order: string[] = [];
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase === "committed") {
      controller.abort();
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
  expect(await h.reconciler.reconcile({ ...h.request, signal: controller.signal })).toMatchObject({
    outcome: "failed",
    failure: { code: "concurrent_modification" },
  });
  expect(h.timer.now()).toBeLessThan(h.request.deadlineMs);
  expect(order.slice(0, 2)).toEqual(["flag", "release"]);
  expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBe(true);
  h.registry.advanceBindingJournal = advance;
  await assertRemovedByNext(h);
  expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
});

test("an expired hung flag releases within its budget and this daemon later removes", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  let writing = false;
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase === "committed") {
      h.timer.setCurrentTime(h.request.deadlineMs + 1);
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    }
    if (input.target?.removalRequested) {
      writing = true;
      return new Promise<never>(() => {});
    }
    return advance(id, input);
  };
  const first = h.reconciler.reconcile(h.request);
  await drainUntil(() => writing, { description: "hung removal flag" });
  expect(h.provisioner.released).toEqual([]);
  h.timer.advanceTime(BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS + 1);
  await drainMicrotasks(156);
  expect(h.provisioner.released).toEqual(["session-1"]);
  expect(await first).toMatchObject({
    outcome: "failed",
    failure: { code: "concurrent_modification" },
  });
  expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBeUndefined();
  h.registry.advanceBindingJournal = advance;
  expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  expect((await h.registry.getBindingJournal(1))?.phase).toBe("rolled_back");
  expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
});

test.each([false, true])("death before flag lands with binding moved: %s", async (bindingMoved) => {
  const h = await harness(true);
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  let writing = false;
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase === "committed") {
      if (bindingMoved) {
        const assignment = (await h.registry.getAssignment(h.key))!;
        expect(
          await h.registry.commitBinding(h.key, assignment, {
            stableDeviceId: null,
            deviceName: null,
            resolvedSpec: null,
            specFingerprint: null,
            state: "provisioning",
          }),
        ).toMatchObject({ kind: "committed" });
        // Exercise the registry's actual CAS refusal against the moved generation.
        return advance(id, input);
      }
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    }
    if (input.target?.removalRequested) {
      writing = true;
      return new Promise<never>(() => {});
    }
    return advance(id, input);
  };
  void h.reconciler.reconcile(h.request);
  await drainUntil(() => writing, { description: "death before flag lands" });
  const entry = (await h.registry.getBindingJournal(1))!;
  const assignment = (await h.registry.getAssignment(h.key))!;
  expect(assignment.stableDeviceId).toBeNull();
  expect(assignment.generation === entry.binding.generation).toBe(!bindingMoved);
  expect(entry).toMatchObject({ phase: "created", target: { newStableId: "UDID-1" } });
  expect(entry.target.removalRequested).toBeUndefined();
  expect(await h.registry.findDeviceHolder("ios", "UDID-1")).toBeNull();
  expect(h.provisioner.released).toEqual([]);
  let adoptionCas = false;
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase === "committed") {
      expect(input.assignment).toMatchObject({
        kind: "commit",
        expected: entry.binding,
        next: { stableDeviceId: "UDID-1", state: "provisioning" },
      });
      adoptionCas = true;
    }
    return advance(id, input);
  };
  // Residual: if refusal clears before takeover, adoption's CAS may bind as provisioning for re-provisioning before use.
  expect(await h.journal(NEXT).redriveBinding(h.key)).toMatchObject({ kind: "clear" });
  expect(adoptionCas).toBe(!bindingMoved);
  if (bindingMoved) {
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
    expect((await h.registry.getBindingJournal(1))?.phase).toBe("rolled_back");
  } else {
    expect(await h.registry.getAssignment(h.key)).toMatchObject({
      stableDeviceId: "UDID-1",
      state: "provisioning",
    });
    expect(h.deleter.calls).toEqual([]);
    expect((await h.registry.getBindingJournal(1))?.phase).toBe("committed");
  }
});

test("busy created write fails, releases, and keeps this daemon from adopting", async () => {
  const h = await harness();
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase === "created") {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return advance(id, input);
  };
  expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
  expect(h.provisioner.released).toEqual(["session-1"]);
  expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBeUndefined();
  h.registry.advanceBindingJournal = advance;
  expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
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
    expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBe(true);
    await assertRemovedByNext(h);
  },
);

test("successful commit survives death without deleting the bound device", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  let committed = false;
  h.registry.advanceBindingJournal = async (id, input) => {
    const result = await advance(id, input);
    if (input.phase === "committed") {
      committed = true;
      return new Promise<never>(() => {});
    }
    return result;
  };
  void h.reconciler.reconcile(h.request);
  await drainUntil(() => committed, { description: "commit" });
  expect(await h.journal(NEXT).redriveBinding(h.key)).toMatchObject({ kind: "clear" });
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
  expect(await h.registry.getBindingJournal(1)).toMatchObject({ phase: "rolled_back" });
  expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBeUndefined();
  expect(h.deleter.calls).toEqual([]);
  expect(h.inventory.has("UDID-1")).toBe(true);
});

test.each(["committed binding", "reported binding holder"] as const)(
  "discard preserves a device held by a winning %s",
  async (holder) => {
    const h = await harness(true);
    const advance = h.registry.advanceBindingJournal.bind(h.registry);
    h.registry.advanceBindingJournal = async (id, input) => {
      if (input.phase !== "committed") {
        return advance(id, input);
      }
      const assignment = (await h.registry.getAssignment(h.key))!;
      if (holder === "committed binding") {
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
        h.registry.findDeviceHolder = async () => ({ kind: "binding", scope, assignment });
      }
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    };
    expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
    expect((await h.registry.getBindingJournal(1))?.phase).toBe("rolled_back");
    expect(h.inventory.has("UDID-1")).toBe(true);
    expect(h.deleter.calls).toEqual([]);
  },
);

test("a busy flag at the expired deadline releases and preserves the refusal and memory fence", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  let flags = 0;
  h.registry.advanceBindingJournal = async (id, input) => {
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
  h.registry.advanceBindingJournal = advance;
  h.timer.advanceTime(10);
  expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
});

test.each(["created", "flag"] as const)(
  "non-retryable %s write failures still release the session and fail",
  async (write) => {
    const h = await harness(write === "flag");
    const advance = h.registry.advanceBindingJournal.bind(h.registry);
    h.registry.advanceBindingJournal = async (id, input) => {
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
    h.registry.advanceBindingJournal = advance;
    expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    expect(h.deleter.stableIds()).toEqual(["UDID-1"]);
  },
);

test("created journal conflict clears the losing driver's memory intent", async () => {
  const h = await harness();
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase !== "created") {
      return advance(id, input);
    }
    await advance(id, {
      ...input,
      target: { newStableId: "UDID-1", newName: h.inventory.devices[0].name },
    });
    return { kind: "journal_conflict", entry: (await h.registry.getBindingJournal(id))! };
  };
  expect((await h.reconciler.reconcile(h.request)).outcome).toBe("failed");
  h.registry.advanceBindingJournal = advance;
  expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getBindingJournal(1))?.phase).toBe("committed");
  expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBe("UDID-1");
  expect(h.deleter.calls).toEqual([]);
});

test.each([false, true])(
  "hung removal flag settles before deadline (aborted=%s)",
  async (aborted) => {
    const h = await harness(true);
    const controller = new AbortController();
    const advance = h.registry.advanceBindingJournal.bind(h.registry);
    let writing = false;
    h.registry.advanceBindingJournal = async (id, input) => {
      if (input.phase === "committed") {
        if (aborted) {
          controller.abort();
        }
        return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
      }
      if (input.target?.removalRequested) {
        writing = true;
        return new Promise<never>(() => {});
      }
      return advance(id, input);
    };
    let settled = false;
    const result = h.reconciler
      .reconcile({ ...h.request, signal: controller.signal })
      .then((value) => {
        settled = true;
        return value;
      });
    await drainUntil(() => writing, { description: "flag write" });
    h.timer.advanceTime(BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS + 1);
    await drainMicrotasks(156);
    expect(settled).toBe(true);
    expect(await result).toMatchObject({
      outcome: "failed",
      failure: { code: "concurrent_modification" },
      evidence: { uncommittedCleanup: { stableId: "UDID-1", removed: false } },
    });
    expect(h.provisioner.released).toEqual(["session-1"]);
    expect(h.deleter.calls).toEqual([]);
    expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBeUndefined();
    h.registry.advanceBindingJournal = advance;
    expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
    expect((await h.registry.getBindingJournal(1))?.phase).toBe("rolled_back");
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    expect(h.inventory.devices).toEqual([]);
  },
);

test.each(["holder", "rollback", "blocked", "assignment", "deadline"] as const)(
  "durable removal survives hung %s",
  async (stage) => {
    const h = await harness(true);
    const advance = h.registry.advanceBindingJournal.bind(h.registry);
    const holder = h.registry.findDeviceHolder.bind(h.registry);
    const assignment = h.registry.getAssignment.bind(h.registry);
    if (stage === "blocked") {
      h.deleter.failWith = "native delete failed";
    }
    let hanging = false;
    let flagged = false;
    h.registry.advanceBindingJournal = async (id, input) => {
      if (input.phase === "committed") {
        return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
      }
      if (
        (stage === "rollback" && input.phase === "rolled_back") ||
        (stage === "blocked" && input.attempt)
      ) {
        hanging = true;
        return new Promise<never>(() => {});
      }
      const value = await advance(id, input);
      if (input.target?.removalRequested) {
        flagged = true;
      }
      return value;
    };
    h.registry.findDeviceHolder = async (platform, id) => {
      if ((stage === "holder" || stage === "deadline") && flagged) {
        hanging = true;
        return new Promise<never>(() => {});
      }
      return holder(platform, id);
    };
    h.registry.getAssignment = async (key) => {
      if (stage === "assignment" && flagged) {
        hanging = true;
        return new Promise<never>(() => {});
      }
      return assignment(key);
    };
    let settled = false;
    const result = h.reconciler.reconcile(h.request).then((value) => {
      settled = true;
      return value;
    });
    await drainUntil(() => hanging, { description: "cleanup stage" });
    h.timer.advanceTime(BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS + 1);
    await drainMicrotasks(156);
    if (stage === "assignment") {
      // Cleanup and the failed-result read each get a bounded registry stage.
      h.timer.advanceTime(BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS + 1);
      await drainMicrotasks(156);
    }
    expect(settled).toBe(true);
    expect(await result).toMatchObject({
      outcome: "failed",
      ...(stage === "assignment" ? { assignment: null } : {}),
      failure: { code: "concurrent_modification" },
      evidence: { uncommittedCleanup: { removed: false } },
    });
    expect(h.provisioner.released).toEqual(["session-1"]);
    expect((await h.registry.getBindingJournal(1))?.phase).toBe("created");
    expect(h.deleter.calls.length).toBe(
      stage === "holder" || stage === "assignment" || stage === "deadline" ? 0 : 1,
    );
    h.registry.advanceBindingJournal = advance;
    h.registry.findDeviceHolder = holder;
    h.registry.getAssignment = assignment;
    h.deleter.failWith = undefined;
    expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
    expect((await h.registry.getBindingJournal(1))?.phase).toBe("rolled_back");
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    expect(h.inventory.devices).toEqual([]);
  },
);

test("healthy cleanup preserves flag release delete rollback order", async () => {
  const h = await harness(true);
  const order: string[] = [];
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  const release = h.provisioner.releaseSession.bind(h.provisioner);
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase === "committed") {
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    }
    if (input.target?.removalRequested) {
      order.push("flag");
    }
    if (input.phase === "rolled_back") {
      order.push("rollback");
    }
    return advance(id, input);
  };
  h.provisioner.releaseSession = async (id) => {
    order.push("release");
    await release(id);
  };
  h.deleter.beforeDelete = async () => {
    order.push("delete");
  };
  expect(await h.reconciler.reconcile(h.request)).toMatchObject({
    outcome: "failed",
    failure: { code: "concurrent_modification" },
  });
  expect(order).toEqual(["flag", "release", "delete", "rollback"]);
});

test("this daemon's redrive bounds its own hung flag rewrite", async () => {
  const h = await harness(true);
  const advance = h.registry.advanceBindingJournal.bind(h.registry);
  let writing = false;
  h.registry.advanceBindingJournal = async (id, input) => {
    if (input.phase === "committed") {
      return { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! };
    }
    if (input.target?.removalRequested) {
      writing = true;
      return new Promise<never>(() => {});
    }
    return advance(id, input);
  };
  let settled = false;
  const first = h.reconciler.reconcile(h.request).then((value) => {
    settled = true;
    return value;
  });
  await drainUntil(() => writing, { description: "first flag write" });
  h.timer.advanceTime(BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS + 1);
  await drainMicrotasks(156);
  expect(settled).toBe(true);
  expect((await first).outcome).toBe("failed");
  writing = false;
  settled = false;
  const redrive = h.driver.redriveBinding(h.key).then((value) => {
    settled = true;
    return value;
  });
  await drainUntil(() => writing, { description: "redrive flag rewrite" });
  h.timer.advanceTime(BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS + 1);
  await drainMicrotasks(156);
  expect(settled).toBe(true);
  expect(await redrive).toMatchObject({ kind: "blocked", reason: "reconcile_in_progress" });
  expect(h.deleter.calls).toEqual([]);
  expect((await h.registry.getBindingJournal(1))?.target.removalRequested).toBeUndefined();
  h.registry.advanceBindingJournal = advance;
  expect(await h.driver.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
  expect((await h.registry.getBindingJournal(1))?.phase).toBe("rolled_back");
});

test.each([false, true])("queued timeout bounds assignment read (hang=%s)", async (hang) => {
  const h = await harness(true);
  const release = Promise.withResolvers<void>();
  let creating = false;
  h.provisioner.beforeCreate = async () => {
    creating = true;
    await release.promise;
  };
  const first = h.reconciler.reconcile(h.request);
  await drainUntil(() => creating, { description: "first creation parked" });
  const read = h.registry.getAssignment.bind(h.registry);
  const assignment = await read(h.key);
  let reading = false;
  h.registry.getAssignment = async (key) => {
    reading = true;
    if (hang) {
      return new Promise<never>(() => {});
    }
    await h.timer.sleep(100);
    return read(key);
  };
  let settled = false;
  const duplicate = h.reconciler
    .reconcile({
      ...h.request,
      deadlineMs: h.timer.now() + 10,
    })
    .then((result) => {
      settled = true;
      return result;
    });
  await drainMicrotasks(156);
  h.timer.advanceTime(10);
  await drainUntil(() => reading, { description: "queued failure assignment read" });
  await drainMicrotasks(156);
  h.timer.advanceTime(100);
  await drainMicrotasks(156);
  if (hang) {
    expect(settled).toBe(false);
    h.timer.advanceTime(BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS - 101);
    await drainMicrotasks(156);
    expect(settled).toBe(false);
    h.timer.advanceTime(1);
  }
  await drainMicrotasks(156);
  expect(settled).toBe(true);
  expect(await duplicate).toMatchObject({
    outcome: "failed",
    failure: { code: "timeout" },
    assignment: hang ? null : assignment,
  });
  h.registry.getAssignment = read;
  release.resolve();
  expect((await first).outcome).toBe("ready");
});

test("expired registry stage keeps immediate answers and times out hung reads at zero", async () => {
  const h = await harness();
  const assignment = await h.registry.getAssignment(h.key);
  expect(
    await h.driver.removalRegistryStage(() => h.registry.getAssignment(h.key), h.timer.now() - 1),
  ).toEqual(assignment);
  let timedOut = false;
  const read = h.driver
    .removalRegistryStage(() => new Promise<never>(() => {}), h.timer.now() - 1)
    .catch((error: unknown) => {
      timedOut = true;
      return error;
    });
  await drainMicrotasks(156);
  expect(timedOut).toBe(false);
  h.timer.advanceTime(0);
  await drainMicrotasks(156);
  expect(timedOut).toBe(true);
  expect(await read).toBeInstanceOf(BindingJournalRemovalRegistryTimeout);
});
