import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import type { SlotProcessIdentity } from "../../../src/daemon/managedSlots/slotRegistry";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import {
  destructionTicket,
  type BrokerAdmissionInput,
  type BrokerResourceRecord,
} from "../../../src/daemon/sessionBroker/store";
import { sessionRequestFingerprint } from "../../../src/daemon/sessionBroker/requestIdentity";

const OWNER: SlotProcessIdentity = { daemonId: "daemon-a", pid: 101, processGenerationToken: "a" };
const SUCCESSOR: SlotProcessIdentity = {
  daemonId: "daemon-b",
  pid: 102,
  processGenerationToken: "b",
};
const PHONE = { platform: "ios", model: "phone", runtime: "27.0" };
const TABLET = { platform: "ios", model: "tablet", runtime: "27.0" };
const CONSUMER_TOKEN = "consumer-owner";

describe("session broker durable admission", () => {
  let registry: SqliteSlotRegistry;
  let store: SqliteSessionBrokerStore;
  let scopeKey: string;
  const livePids = new Set<number>();

  beforeEach(async () => {
    livePids.clear();
    livePids.add(OWNER.pid);
    registry = await openSqliteSlotRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: (owner) => livePids.has(owner.pid),
    });
    const result = await registry.ensureScope({
      managedHostScope: "broker-host",
      runnerNamespace: "private-session-broker",
      runnerIncarnation: "persistent-pool-v1",
    });
    if (result.kind !== "ready") {
      throw new Error("Test broker scope could not be initialized");
    }
    scopeKey = result.scope.scopeKey;
    store = registry.sessionBrokerStore(scopeKey, new CountingIdGenerator("resource"));
  });

  afterEach(async () => {
    await registry.close();
  });

  function input(
    requestId: string,
    extra: Partial<BrokerAdmissionInput> = {},
  ): BrokerAdmissionInput {
    return {
      requestId,
      fingerprint: `parameters:${requestId}`,
      parameters: { device: "phone" },
      owner: OWNER,
      limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 2 },
      resolveCreation: () => PHONE,
      matches: (profile) => JSON.stringify(profile) === JSON.stringify(PHONE),
      ...extra,
    };
  }

  function key(resource: BrokerResourceRecord) {
    return { scopeKey: resource.scopeKey, slotIndex: resource.allocationIndex };
  }

  async function prepare(
    requestId: string,
    extra: Partial<BrokerAdmissionInput> = {},
    claimOwner: SlotProcessIdentity = OWNER,
  ) {
    const admission = await store.admit(input(requestId, extra));
    if (admission.kind !== "create" && admission.kind !== "reuse") {
      throw new Error(`Unexpected admission: ${admission.kind}`);
    }
    const resource = admission.resource;
    const sessionId = `session-${requestId}`;
    if (admission.kind === "create") {
      await registry.initSlot(key(resource), {
        platform: "ios",
        role: "primary",
        requestedSpec: resource.profile,
      });
      expect(
        await registry.commitBinding(
          key(resource),
          { generation: 0, stableDeviceId: null },
          {
            stableDeviceId: `device-${resource.resourceId}`,
            deviceName: `private-${resource.resourceId}`,
            resolvedSpec: resource.profile,
            specFingerprint: "profile",
            state: "ready",
          },
        ),
      ).toMatchObject({ kind: "committed" });
    }
    const assignment = await registry.getAssignment(key(resource));
    if (!assignment) {
      throw new Error("Missing test physical binding");
    }
    expect(
      await registry.claimExecution(key(resource), assignment, {
        ...claimOwner,
        sessionUuid: sessionId,
      }),
    ).toMatchObject({ kind: "claimed" });
    await store.activate(requestId, extra.owner ?? OWNER, sessionId);
    return { resource, sessionId };
  }

  async function returnClean(requestId: string, resource: BrokerResourceRecord) {
    await store.beginRelease(`session-${requestId}`, OWNER);
    await registry.releaseExecution(key(resource), `session-${requestId}`);
    await store.completeCleanRelease(requestId, OWNER, input(requestId).limits);
  }

  async function clearPhysicalBinding(resource: BrokerResourceRecord) {
    const assignment = await registry.getAssignment(key(resource));
    if (assignment) {
      expect(
        await registry.commitBinding(key(resource), assignment, {
          stableDeviceId: null,
          deviceName: null,
          resolvedSpec: null,
          specFingerprint: null,
          state: "ready",
        }),
      ).toMatchObject({ kind: "committed" });
    }
  }

  test("concurrent acquisitions reserve before native work and cannot oversubscribe", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.admit(input(`parallel-${index}`))),
    );
    expect(outcomes.filter((entry) => entry.kind === "create")).toHaveLength(2);
    expect(outcomes.filter((entry) => entry.kind === "refused")).toHaveLength(18);
    expect(await store.listResources()).toHaveLength(2);
    expect((await store.listResources()).every((entry) => entry.state === "reserved")).toBe(true);
  });

  test("ambiguous acquisition replay returns one receipt and one reservation", async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store.admit(input("same"))));
    expect(outcomes.filter((entry) => entry.kind === "create")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.kind === "existing")).toHaveLength(7);
    expect(await store.listResources()).toHaveLength(1);
    await expect(store.admit(input("same", { fingerprint: "changed" }))).rejects.toThrow(
      "different parameters",
    );
  });

  test("activation requires the real physical session claim", async () => {
    await store.admit(input("unbound"));
    await expect(store.activate("unbound", OWNER, "invented-session")).rejects.toThrow(
      "physical device binding",
    );
    expect(await store.getRequest("unbound")).toMatchObject({
      state: "acquiring",
      sessionId: null,
    });
    const prepared = await prepare("bound");
    expect(await store.activate("bound", OWNER, prepared.sessionId)).toMatchObject({
      state: "active",
    });
  });

  test("activation rejects a physical claim from another generation of the same daemon PID", async () => {
    await expect(
      prepare("wrong-generation", {}, { ...OWNER, processGenerationToken: "different-start" }),
    ).rejects.toThrow("physical device binding");
    expect(await store.getRequest("wrong-generation")).toMatchObject({
      state: "acquiring",
      sessionId: null,
    });
    expect((await store.listResources())[0].state).toBe("reserved");
  });

  test("activation supports owners whose platform supplies no generation token", async () => {
    const owner = { daemonId: OWNER.daemonId, pid: OWNER.pid };
    const prepared = await prepare("no-generation", { owner }, owner);
    expect(await store.getSession(prepared.sessionId)).toMatchObject({ state: "active" });
  });

  test("pre-admission refusal keeps its identity without reserving device or session capacity", async () => {
    const refusal = await store.recordPreAdmissionFailure(input("unavailable"), {
      code: "catalog_unavailable",
      retryable: true,
      message: "No authoritative inventory",
    });
    expect(refusal).toMatchObject({
      state: "failed",
      resourceId: null,
      sessionId: null,
      retryable: true,
    });
    expect(await registry.sessionBrokerStore(scopeKey).getRequest("unavailable")).toEqual(refusal);
    expect(await store.admit(input("unavailable"))).toEqual({
      kind: "existing",
      request: refusal,
    });
    await expect(
      store.recordPreAdmissionFailure(input("unavailable", { fingerprint: "changed" }), {
        code: "another_error",
        retryable: false,
        message: "Must not replace existing failure",
      }),
    ).rejects.toThrow("different parameters");
    expect(await store.getRequest("unavailable")).toEqual(refusal);
    expect(await store.listResources()).toHaveLength(0);
    expect(
      await store.admit(input("new-attempt", { limits: { totalDeviceCap: 1, sessionCap: 1 } })),
    ).toMatchObject({ kind: "create" });
  });

  test("abandoning an unknown identity creates an owner-fenced terminal tombstone", async () => {
    const abandoned = await store.abandon("never-admitted", OWNER, CONSUMER_TOKEN);
    expect(abandoned.request).toMatchObject({
      requestId: "never-admitted",
      state: "failed",
      resourceId: null,
      sessionId: null,
      errorCode: "session_request_abandoned",
    });
    expect(abandoned.ticket).toBeUndefined();
    expect(await store.abandon("never-admitted", OWNER, CONSUMER_TOKEN)).toEqual(abandoned);
    await expect(store.abandon("never-admitted", OWNER, "different-owner")).rejects.toThrow(
      "another liveness owner",
    );
  });

  test("abandoning an active request atomically preserves its session and cleanup ownership", async () => {
    const parameters = input("active").parameters;
    const active = await prepare("active", {
      fingerprint: sessionRequestFingerprint(parameters, CONSUMER_TOKEN),
    });
    const abandoned = await store.abandon("active", OWNER, CONSUMER_TOKEN);
    expect(abandoned.request).toMatchObject({
      state: "failed",
      sessionId: active.sessionId,
      errorCode: "session_request_abandoned",
    });
    expect(abandoned.ticket).toEqual(
      destructionTicket(
        (await store.listResources()).find(
          (resource) => resource.resourceId === active.resource.resourceId,
        )!,
      ),
    );
    expect((await store.listResources())[0]?.state).toBe("destroying");
    expect(await store.confirmDestroyed(abandoned.ticket!)).toBe(false);
  });

  test("released acquisition receipt never grants another session after physical reuse", async () => {
    const first = await prepare("first");
    await returnClean("first", first.resource);
    const second = await prepare("second");
    expect(second.resource.resourceId).toBe(first.resource.resourceId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await store.admit(input("first"))).toMatchObject({
      kind: "existing",
      request: { state: "released", sessionId: first.sessionId },
    });
    expect(await store.beginRelease(first.sessionId, OWNER)).toMatchObject({ state: "released" });
    expect(await store.fail("first", OWNER, "late timeout")).toBeUndefined();
    expect(await store.getSession(second.sessionId)).toMatchObject({ state: "active" });
    expect((await registry.getAssignment(key(second.resource)))?.execOwner?.sessionUuid).toBe(
      second.sessionId,
    );
  });

  test("cache hit does not require a creation default to be installed", async () => {
    const first = await prepare("first");
    await returnClean("first", first.resource);
    const outcome = await store.admit(
      input("reuse", {
        resolveCreation: () => {
          throw new Error("Creation defaults unavailable");
        },
      }),
    );
    expect(outcome.kind).toBe("reuse");
  });

  test("a committed release replays after daemon restart without touching a successor session", async () => {
    const first = await prepare("first");
    await returnClean("first", first.resource);
    const second = await prepare("second");
    expect(second.resource.resourceId).toBe(first.resource.resourceId);
    expect(await store.beginRelease(first.sessionId, SUCCESSOR)).toMatchObject({
      state: "released",
      sessionId: first.sessionId,
    });
    expect(await store.getRequest("second")).toMatchObject({ state: "active" });
    expect((await registry.getAssignment(key(second.resource)))?.execOwner?.sessionUuid).toBe(
      second.sessionId,
    );
  });

  test("incompatible miss checks creation viability before destroying an idle device", async () => {
    const first = await prepare("first");
    await returnClean("first", first.resource);
    await expect(
      store.admit(
        input("unsupported", {
          limits: { totalDeviceCap: 1 },
          matches: () => false,
          resolveCreation: () => {
            throw new Error("Requested device is unavailable");
          },
        }),
      ),
    ).rejects.toThrow("unavailable");
    expect((await store.listResources())[0]?.state).toBe("idle");
    expect(await store.getRequest("unsupported")).toBeUndefined();
  });

  test("full pool miss cannot create until eviction is authoritatively confirmed", async () => {
    const first = await prepare("first");
    await returnClean("first", first.resource);
    const tablet = input("tablet", {
      limits: { totalDeviceCap: 1, sessionCap: 2 },
      matches: () => false,
      resolveCreation: () => TABLET,
    });
    const outcome = await store.admit(tablet);
    if (outcome.kind !== "evict") {
      throw new Error(`Expected eviction, got ${outcome.kind}`);
    }
    expect(
      (await store.listResources()).filter((entry) => entry.state !== "destroyed"),
    ).toHaveLength(1);
    await expect(store.continueAdmission(tablet)).rejects.toThrow("confirmed eviction");
    expect(await store.confirmDestroyed(destructionTicket(outcome.resource))).toBe(false);
    await clearPhysicalBinding(outcome.resource);
    expect(await store.confirmDestroyed(destructionTicket(outcome.resource))).toBe(true);
    expect(await store.confirmDestroyed(destructionTicket(outcome.resource))).toBe(true);
    const replacement = await store.continueAdmission(tablet);
    expect(replacement.kind).toBe("create");
    expect(
      (await store.listResources()).filter((entry) => entry.state !== "destroyed"),
    ).toHaveLength(1);
    if (replacement.kind === "create") {
      expect(replacement.resource.allocationIndex).not.toBe(outcome.resource.allocationIndex);
      expect(replacement.resource.profile).toEqual(TABLET);
    }
  });

  test("failed cleanup continues counting against the total cap", async () => {
    await store.admit(input("failed", { limits: { totalDeviceCap: 1 } }));
    const ticket = await store.fail("failed", OWNER, "ambiguous platform response");
    expect(ticket).toBeDefined();
    expect(await store.admit(input("next", { limits: { totalDeviceCap: 1 } }))).toMatchObject({
      kind: "refused",
      reason: "total-device-cap-reached",
    });
    expect(await store.admit(input("failed"))).toMatchObject({
      kind: "existing",
      request: { state: "failed", error: "ambiguous platform response" },
    });
    expect((await store.listResources())[0]?.state).toBe("destroying");
  });

  test("ambiguous failed work also retains session capacity until cleanup finishes", async () => {
    const limits = { totalDeviceCap: 2, sessionCap: 1 };
    await store.admit(input("failed", { limits }));
    const ticket = await store.fail("failed", OWNER, "native session may still be active");
    expect(await store.admit(input("blocked", { limits }))).toMatchObject({
      kind: "refused",
      reason: "session-cap-reached",
    });
    if (!ticket) {
      throw new Error("Missing cleanup ticket");
    }
    expect(await store.confirmDestroyed(ticket)).toBe(true);
    expect(await store.admit(input("after-cleanup", { limits }))).toMatchObject({ kind: "create" });
  });

  test("native creation journal blocks cleanup confirmation even before a device is bound", async () => {
    const outcome = await store.admit(input("creating"));
    if (outcome.kind !== "create") {
      throw new Error("Expected create");
    }
    const resource = outcome.resource;
    await registry.initSlot(key(resource), {
      platform: "ios",
      role: "primary",
      requestedSpec: PHONE,
    });
    const journal = await registry.openSlotJournal(key(resource), {
      kind: "create",
      phase: "creating",
      owner: OWNER,
      target: {
        oldStableId: null,
        oldName: null,
        newName: "possibly-created",
        newStableId: null,
        requestedSpec: PHONE,
        resolvedSpec: PHONE,
        specFingerprint: "phone",
      },
      assignment: {
        kind: "state",
        expected: { generation: 0, stableDeviceId: null },
        state: "provisioning",
      },
    });
    expect(journal.kind).toBe("opened");
    const ticket = await store.fail("creating", OWNER, "native response lost");
    if (!ticket) {
      throw new Error("Expected cleanup ticket");
    }
    expect(await store.confirmDestroyed(ticket)).toBe(false);
    expect((await store.listResources())[0]?.state).toBe("destroying");
  });

  test("release cannot return a device while its old session still owns physical execution", async () => {
    const first = await prepare("first");
    await store.beginRelease(first.sessionId, OWNER);
    await expect(store.completeCleanRelease("first", OWNER, {})).rejects.toThrow(
      "execution or journal work",
    );
    expect((await store.listResources())[0]?.state).toBe("resetting");
    await registry.releaseExecution(key(first.resource), first.sessionId);
    await store.completeCleanRelease("first", OWNER, {});
    expect((await store.listResources())[0]?.state).toBe("idle");
  });

  test("zero-pool release retains cleanup ownership until confirmed destruction", async () => {
    const first = await prepare("first");
    await store.beginRelease(first.sessionId, OWNER);
    const ticket = await store.releaseByDestruction("first", OWNER);
    if (!ticket) {
      throw new Error("Expected cleanup");
    }
    expect(await store.getRequest("first")).toMatchObject({ state: "releasing" });
    expect(await store.confirmDestroyed(ticket)).toBe(false);
    await registry.releaseExecution(key(first.resource), first.sessionId);
    await clearPhysicalBinding(first.resource);
    expect(await store.confirmDestroyed(ticket)).toBe(true);
    expect(await store.getRequest("first")).toMatchObject({ state: "released" });
  });

  test("return-time idle cap schedules destruction atomically with terminal receipt", async () => {
    const first = await prepare("first");
    await store.beginRelease(first.sessionId, OWNER);
    await registry.releaseExecution(key(first.resource), first.sessionId);
    const tickets = await store.completeCleanRelease("first", OWNER, { idlePoolCap: 0 });
    expect(tickets).toHaveLength(1);
    expect(await store.getRequest("first")).toMatchObject({ state: "released" });
    expect((await store.listResources())[0]?.state).toBe("destroying");
    expect(await store.confirmDestroyed(tickets[0])).toBe(false);
  });

  test("recovery retains uncertain live owners, then fences dead owners without freeing capacity", async () => {
    await store.admit(input("crashed", { limits: { totalDeviceCap: 1 } }));
    expect(await store.recoverRequest("crashed", SUCCESSOR)).toBeUndefined();
    expect(await store.getRequest("crashed")).toMatchObject({ state: "acquiring", owner: OWNER });
    livePids.delete(OWNER.pid);
    const ticket = await store.recoverRequest("crashed", SUCCESSOR);
    expect(ticket).toBeDefined();
    expect(await store.getRequest("crashed")).toMatchObject({ state: "failed", owner: SUCCESSOR });
    await expect(store.fail("crashed", OWNER, "stale callback")).rejects.toThrow("another daemon");
    expect(
      await store.admit(input("next", { owner: SUCCESSOR, limits: { totalDeviceCap: 1 } })),
    ).toMatchObject({
      kind: "refused",
    });
    expect((await store.listResources())[0]?.state).toBe("destroying");
  });

  test("stale destruction ticket cannot clear a later cleanup generation", async () => {
    const first = await prepare("first");
    await returnClean("first", first.resource);
    const second = await store.admit(
      input("evict", { matches: () => false, limits: { totalDeviceCap: 1 } }),
    );
    if (second.kind !== "evict") {
      throw new Error("Expected eviction");
    }
    const oldTicket = destructionTicket(second.resource);
    const newTicket = await store.fail("evict", OWNER, "cancelled during eviction");
    expect(newTicket?.revision).not.toBe(oldTicket.revision);
    await clearPhysicalBinding(second.resource);
    expect(await store.confirmDestroyed(oldTicket)).toBe(false);
    if (!newTicket) {
      throw new Error("Missing current cleanup ticket");
    }
    expect(await store.confirmDestroyed(newTicket)).toBe(true);
  });
});
