import { FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import { SessionBrokerFailureError } from "../../../src/daemon/sessionBroker/devicePort";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import type { SlotProcessIdentity } from "../../../src/daemon/managedSlots/slotRegistry";
import { parseSessionConfig, type SessionConfig } from "../../../src/models/sessionConfig";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";

const OWNER: SlotProcessIdentity = {
  daemonId: "broker-daemon",
  pid: 101,
  processGenerationToken: "start-a",
};

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

describe("session-only broker lifecycle", () => {
  let registry: SqliteSlotRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;
  let ownerLive = true;

  beforeAll(async () => {
    // Warm SQLite/migration setup outside the per-test budget, as the shared DB harness does.
    const warm = await openSqliteSlotRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    ownerLive = true;
    registry = await openSqliteSlotRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: () => ownerLive,
    });
    const scope = await registry.ensureScope({
      managedHostScope: "private-host",
      runnerNamespace: "private-broker",
      runnerIncarnation: "persistent",
    });
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    devices = new FakeNativePort(registry);
    options = {
      store: registry.sessionBrokerStore(scope.scope.scopeKey, new CountingIdGenerator("resource")),
      devices,
      owner: OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 1 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  async function ready(requestId: string) {
    const result = await broker.prepare(config(requestId), "owner-token");
    expect(result.outcome).toBe("ready");
    if (!result.sessionUuid) {
      throw new Error(JSON.stringify(result));
    }
    return result.sessionUuid;
  }

  test.each([
    ["timeout", true, true],
    ["spec_unsupported", false, true],
    ["timeout", true, false],
  ] as const)(
    "typed %s retryable=%s with confirmed cleanup=%s survives replay and reopened store",
    async (code, retryable, cleanupConfirmed) => {
      devices.prepareError = new SessionBrokerFailureError({
        code,
        retryable,
        message: "native preparation failed",
      });
      devices.canDestroy = cleanupConfirmed;
      const failed = await broker.prepare(config("typed-failure"), "owner-token");
      expect(failed).toMatchObject({
        outcome: "failed",
        cleanupPending: !cleanupConfirmed,
        failure: { code, retryable: retryable && cleanupConfirmed },
      });
      expect(await broker.prepare(config("typed-failure"), "owner-token")).toEqual(failed);
      expect(devices.prepared).toHaveLength(1);
      const scopeKey = (await options.store.listResources())[0].scopeKey;
      const reopened = new SessionBroker({
        ...options,
        store: registry.sessionBrokerStore(scopeKey),
      });
      expect(await reopened.ownedStatus("typed-failure", "owner-token")).toEqual(failed);
      if (!cleanupConfirmed) {
        devices.canDestroy = true;
        await reopened.recover();
        expect(await reopened.status("typed-failure")).toMatchObject({
          cleanupPending: false,
          failure: { code, retryable },
        });
      }
    },
  );

  test("typed pre-admission failure retains retryability after reopening the store", async () => {
    const failure = { code: "timeout", retryable: true, message: "catalog readiness timed out" };
    options.catalog = () => Promise.reject(new SessionBrokerFailureError(failure));
    const failed = await broker.prepare(config("catalog-transient"), "owner-token");
    expect(failed.failure).toEqual(failure);
    const reopened = new SessionBroker({
      ...options,
      store: registry.sessionBrokerStore("unused-scope"),
    });
    expect(await reopened.ownedStatus("catalog-transient", "owner-token")).toEqual(failed);
    expect(await reopened.prepare(config("catalog-transient"), "owner-token")).toEqual(failed);
    expect(devices.prepared).toEqual([]);
  });

  test("untyped preparation error remains permanent and generic", async () => {
    devices.prepareError = new Error("native error");
    expect(await broker.prepare(config("untyped"), "owner-token")).toMatchObject({
      outcome: "failed",
      failure: { code: "session_preparation_failed", retryable: false },
    });
  });

  test("recoverable restart handoff and return preserve the active UUID until expiry", async () => {
    const timer = new FakeTimer();
    let returned = false;
    // This seam must be consulted even though the session is temporarily absent from memory.
    options.sessionDisposition = () =>
      Promise.resolve(returned ? "live" : timer.now() < 100 ? "recoverable-handoff" : "gone");
    const uuid = await ready("handoff");
    const receipt = await options.store.getRequest("handoff");
    await broker.recover();
    expect(devices.destroyed).toEqual([]);
    expect(devices.released).toEqual([]);
    expect(await options.store.getRequest("handoff")).toEqual(receipt);
    returned = true;
    await broker.recover();
    expect(await broker.status("handoff")).toMatchObject({ outcome: "ready", sessionUuid: uuid });
    expect(devices.released).toEqual([]);
    returned = false;
    timer.advanceTime(101);
    devices.canDestroy = false;
    await broker.recover();
    expect(await broker.status("handoff")).toMatchObject({
      outcome: "pending",
      cleanupPending: true,
    });
    const resource = (await options.store.listResources())[0];
    expect(resource).toMatchObject({ state: "destroying", requestId: "handoff" });
    expect(resource.revision).toBeGreaterThan(1);
    expect(devices.released).toEqual([uuid]);
    devices.canDestroy = true;
    await broker.recover();
    await broker.recover();
    expect(devices.destroyed).toEqual([resource.resourceId]);
    expect(await broker.status("handoff")).toMatchObject({
      outcome: "released",
      sessionUuid: uuid,
    });
  });

  test("explicit owner release during restart handoff still destroys normally", async () => {
    options.sessionDisposition = () => "recoverable-handoff";
    const uuid = await ready("owner-release");
    expect(await broker.release(uuid)).toEqual({ sessionUuid: uuid, outcome: "released" });
    expect(devices.destroyed).toHaveLength(1);
  });

  test("dead process ownership is recovered regardless of session disposition", async () => {
    await ready("dead-owner");
    ownerLive = false;
    devices.canDestroy = false;
    const successor = new SessionBroker({
      ...options,
      owner: { ...OWNER, pid: 202, daemonId: "successor" },
      sessionDisposition: () => "recoverable-handoff",
    });
    // The real store's injected process liveness authority controls takeover.
    const recover = spyOn(options.store, "recoverRequest");
    await successor.recover();
    expect(recover).toHaveBeenCalledWith("dead-owner", expect.objectContaining({ pid: 202 }));
    recover.mockRestore();
    expect(await options.store.getRequest("dead-owner")).toMatchObject({
      state: "failed",
      errorCode: "session_owner_exited",
      sessionId: "session-1",
    });
    expect((await options.store.listResources())[0]).toMatchObject({
      state: "destroying",
      requestId: "dead-owner",
    });
    devices.canDestroy = true;
    await successor.recover();
    expect(devices.destroyed).toHaveLength(1);
  });

  test("consumer configuration rejects slot, scope, lane and capacity inputs", () => {
    expect(parseSessionConfig(config("plain"))).toEqual(config("plain"));
    for (const field of ["slotIndex", "managedHostScope", "localSlotCapacity", "runnerNamespace"]) {
      expect(() => parseSessionConfig({ ...config("bad"), [field]: 1 })).toThrow(
        "Invalid session configuration",
      );
    }
    expect(() =>
      parseSessionConfig({
        ...config("bad"),
        device: { ...config("bad").device, slotIndex: 0 },
      }),
    ).toThrow("invalid_request");
  });

  test("zero pooling creates fresh sessions and confirms destruction on release", async () => {
    const first = await ready("first");
    expect(await broker.hasActiveSession(first)).toBe(true);
    expect(await broker.release(first)).toEqual({ sessionUuid: first, outcome: "released" });
    expect(await broker.hasActiveSession(first)).toBe(false);
    const second = await ready("second");
    expect(second).not.toBe(first);
    expect(devices.prepared[1]).not.toBe(devices.prepared[0]);
    expect(devices.resetResources).toEqual([]);
    const result = await broker.status("second");
    expect(Object.keys(result ?? {})).not.toContain("scope");
    expect(Object.keys(result ?? {})).not.toContain("slots");
  });

  test("a failed request recovery does not starve later durable cleanup", async () => {
    options.limits = { totalDeviceCap: 2, sessionCap: 2 };
    await ready("first");
    const second = await ready("second");
    devices.canDestroy = false;
    await broker.release(second);
    devices.canDestroy = true;
    const original = options.store.recoverRequest.bind(options.store);
    const recover = spyOn(options.store, "recoverRequest").mockImplementation((id, owner) => {
      if (id === "first") {
        throw new Error("request-specific recovery failure");
      }
      return original(id, owner);
    });
    try {
      await broker.recover();
      expect(await broker.status("second")).toMatchObject({
        outcome: "released",
        cleanupPending: false,
      });
      expect(recover.mock.calls.map(([id]) => id)).toEqual(["first", "second"]);
    } finally {
      recover.mockRestore();
    }
  });

  test("release/reacquire can reuse only a reset device and fresh session identity", async () => {
    broker = new SessionBroker({ ...options, reuseCleanDevices: true });
    const first = await ready("first");
    devices.dirty.add(devices.prepared[0]);
    expect(await broker.release(first)).toMatchObject({ outcome: "released" });
    expect(devices.dirty.size).toBe(0);
    const second = await ready("second");
    expect(second).not.toBe(first);
    expect(devices.prepared[1]).toBe(devices.prepared[0]);
    expect(await broker.release(first)).toMatchObject({ outcome: "released" });
    expect(devices.sessions.has(second)).toBe(true);
  });

  test("lost prepare reply replays original session despite unavailable catalog", async () => {
    const first = await ready("first");
    options.catalog = async () => {
      throw new Error("Catalog temporarily unavailable");
    };
    expect(await broker.prepare(config("first"), "owner-token")).toMatchObject({
      outcome: "ready",
      sessionUuid: first,
    });
    expect(devices.prepared).toHaveLength(1);
    await broker.release(first);
    expect(await broker.prepare(config("first"), "owner-token")).toMatchObject({
      outcome: "released",
      sessionUuid: first,
    });
    expect(devices.prepared).toHaveLength(1);
  });

  test("changing consumer ownership cannot replay another owner's request", async () => {
    const first = await ready("first");
    expect(await broker.prepare(config("first"), "different-owner")).toMatchObject({
      outcome: "failed",
      failure: { message: "Session request identity was already used with different parameters" },
    });
    expect(devices.sessions.has(first)).toBe(true);
  });

  test("catalog failure remains terminal after the host catalog becomes available", async () => {
    options.catalog = async () => {
      throw new Error("Catalog temporarily unavailable");
    };
    const failed = await broker.prepare(config("catalog-failure"), "owner-token");
    expect(failed).toMatchObject({
      outcome: "failed",
      failure: { message: "Catalog temporarily unavailable" },
      cleanupPending: false,
    });
    expect(await broker.ownedStatus("catalog-failure", "owner-token")).toEqual(failed);
    expect(await options.store.listResources()).toHaveLength(0);
    options.catalog = async () => iosCatalog();
    expect(await broker.prepare(config("catalog-failure"), "owner-token")).toEqual(failed);
    expect(devices.prepared).toHaveLength(0);
    await ready("new-attempt");
  });

  test("abandoning an unknown identity is terminal and blocks every late prepare", async () => {
    const abandoned = await broker.abandon("never-sent", "owner-token");
    expect(abandoned).toMatchObject({
      requestId: "never-sent",
      outcome: "failed",
      sessionUuid: null,
      cleanupPending: false,
      failure: { code: "session_request_abandoned", retryable: false },
    });
    expect(await broker.prepare(config("never-sent"), "owner-token")).toEqual(abandoned);
    expect(devices.prepared).toHaveLength(0);
    await expect(broker.abandon("never-sent", "different-owner")).rejects.toThrow(
      "another liveness owner",
    );
  });

  test("abandonment wins while the original prepare is still resolving its catalog", async () => {
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    options.catalog = async () => {
      entered.resolve();
      await complete.promise;
      return iosCatalog();
    };
    const pending = broker.prepare(config("catalog-race"), "owner-token");
    await entered.promise;
    const abandoned = await broker.abandon("catalog-race", "owner-token");
    expect(abandoned).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
      failure: { code: "session_request_abandoned" },
    });
    complete.resolve();
    expect(await pending).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: { code: "session_request_abandoned" },
    });
    expect(await broker.status("catalog-race")).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: { code: "session_request_abandoned" },
    });
    expect(devices.prepared).toHaveLength(0);
  });

  test("abandoning an active request releases its exact session and retires its device", async () => {
    const sessionId = await ready("active-abandon");
    devices.canDestroy = false;
    expect(await broker.abandon("active-abandon", "owner-token")).toMatchObject({
      outcome: "failed",
      sessionUuid: sessionId,
      cleanupPending: true,
      failure: { code: "session_request_abandoned" },
    });
    expect(devices.sessions.has(sessionId)).toBe(false);
    expect(await broker.hasActiveSession(sessionId)).toBe(false);
    devices.canDestroy = true;
    await broker.recover();
    expect(await broker.status("active-abandon")).toMatchObject({
      outcome: "failed",
      sessionUuid: sessionId,
      cleanupPending: false,
      failure: { code: "session_request_abandoned" },
    });
  });

  test("a concurrent catalog failure cannot overwrite an admitted sibling request", async () => {
    const failingReadStarted = Promise.withResolvers<void>();
    const failRead = Promise.withResolvers<void>();
    let reads = 0;
    options.catalog = async () => {
      if (++reads === 1) {
        failingReadStarted.resolve();
        await failRead.promise;
        throw new Error("First catalog read failed");
      }
      return iosCatalog();
    };
    const pending = broker.prepare(config("same-request"), "owner-token");
    await failingReadStarted.promise;
    const successful = await broker
      .prepare(config("same-request"), "owner-token")
      .finally(() => failRead.resolve());
    expect(await pending).toEqual(successful);
    expect(successful.outcome).toBe("ready");
    expect(devices.prepared).toHaveLength(1);
    expect(await options.store.listResources()).toHaveLength(1);
  });

  test("failure to persist a refusal is an error, not an unrecorded terminal receipt", async () => {
    options.catalog = async () => {
      throw new Error("Catalog temporarily unavailable");
    };
    const persist = spyOn(options.store, "recordPreAdmissionFailure").mockRejectedValue(
      new Error("Receipt storage unavailable"),
    );
    try {
      await expect(broker.prepare(config("unrecorded"), "owner-token")).rejects.toThrow(
        "Receipt storage unavailable",
      );
      expect(await broker.status("unrecorded")).toBeUndefined();
      expect(devices.prepared).toHaveLength(0);
    } finally {
      persist.mockRestore();
    }
  });

  test("Duo refusal happens before capacity and never evicts a device", async () => {
    await ready("first");
    const request = config("duo");
    request.device.hardware = { kind: "archetype", archetype: "duo" };
    expect(await broker.prepare(request, "owner-token")).toMatchObject({
      outcome: "failed",
      failure: { code: "capability_disabled" },
    });
    expect(devices.prepared).toHaveLength(1);
    expect(devices.destroyed).toHaveLength(0);
    expect(await options.store.getRequest("duo")).toMatchObject({
      state: "failed",
      errorCode: "capability_disabled",
      resourceId: null,
    });
  });

  test("acquisition failure after a native claim drains it and never exposes a ready session", async () => {
    devices.prepareError = new Error("Automation readiness failed after boot");
    expect(await broker.prepare(config("failed"), "owner-token")).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      cleanupPending: false,
    });
    expect(devices.sessions.size).toBe(0);
    expect((await options.store.listResources())[0].state).toBe("destroyed");
    devices.prepareError = undefined;
    await ready("next");
  });

  test("failed destruction remains counted until a later recovery pass confirms absence", async () => {
    const first = await ready("first");
    devices.canDestroy = false;
    expect(await broker.release(first)).toMatchObject({ outcome: "cleanup_pending" });
    expect(await broker.prepare(config("blocked"), "owner-token")).toMatchObject({
      outcome: "failed",
    });
    expect(devices.prepared).toHaveLength(1);
    devices.canDestroy = true;
    await broker.recover();
    expect(await broker.status("first")).toMatchObject({
      outcome: "released",
      cleanupPending: false,
    });
    await ready("next");
  });

  test("reset exception retires the device instead of reusing contaminated state", async () => {
    broker = new SessionBroker({ ...options, reuseCleanDevices: true });
    const first = await ready("first");
    devices.resetError = new Error("Cannot verify baseline");
    devices.canDestroy = false;
    expect(await broker.release(first)).toMatchObject({ outcome: "cleanup_pending" });
    expect((await options.store.listResources())[0].state).toBe("destroying");
    devices.canDestroy = true;
    await broker.recover();
    devices.resetError = undefined;
    await ready("second");
    expect(devices.prepared[1]).not.toBe(devices.prepared[0]);
  });

  test("in-flight acquisition remains owned while a recovery pass runs", async () => {
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    devices.prepareHook = async () => {
      entered.resolve();
      await complete.promise;
    };
    const pending = broker.prepare(config("in-flight"), "owner-token");
    await entered.promise;
    try {
      await broker.recover();
      expect(await broker.status("in-flight")).toMatchObject({ outcome: "pending" });
      expect(await broker.prepare(config("in-flight"), "owner-token")).toMatchObject({
        outcome: "pending",
      });
      expect(devices.prepared).toHaveLength(1);
    } finally {
      complete.resolve();
    }
    expect(await pending).toMatchObject({ outcome: "ready" });
  });

  test("abandoning an in-flight prepare aborts it and recovery drains a late native claim", async () => {
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    devices.canDestroy = false;
    devices.prepareHook = async (request) => {
      request.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await complete.promise;
    };
    const pending = broker.prepare(config("in-flight-abandon"), "owner-token");
    await entered.promise;
    const abandoned = await broker.abandon("in-flight-abandon", "owner-token");
    expect(abandoned).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
      failure: { code: "session_request_abandoned" },
    });
    await aborted.promise;
    await broker.recover();
    expect(devices.destroyed).toHaveLength(0);
    complete.resolve();
    expect(await pending).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
      failure: { code: "session_request_abandoned" },
    });
    expect(devices.sessions.size).toBe(1);
    devices.canDestroy = true;
    await broker.recover();
    expect(devices.sessions.size).toBe(0);
    expect(await broker.status("in-flight-abandon")).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: { code: "session_request_abandoned" },
    });
  });

  test("shutdown cancels and joins acquisition before returning", async () => {
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    devices.prepareHook = async (request) => {
      request.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await complete.promise;
    };
    const pending = broker.prepare(config("shutdown"), "owner-token");
    await entered.promise;
    let closed = false;
    const close = broker.close().then(() => {
      closed = true;
    });
    await aborted.promise;
    expect(closed).toBe(false);
    complete.resolve();
    expect(await pending).toMatchObject({ outcome: "failed", cleanupPending: false });
    await close;
    expect(devices.sessions.size).toBe(0);
    await expect(broker.prepare(config("late"), "owner-token")).rejects.toThrow("stopping");
  });

  test("duplicate release joins the same in-flight drain", async () => {
    const first = await ready("first");
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    let releases = 0;
    devices.releaseHook = async () => {
      releases++;
      entered.resolve();
      await complete.promise;
    };
    const a = broker.release(first);
    await entered.promise;
    const b = broker.release(first);
    expect(b).toBe(a);
    complete.resolve();
    expect(await a).toMatchObject({ outcome: "released" });
    expect(await b).toMatchObject({ outcome: "released" });
    expect(releases).toBe(1);
  });

  test("shutdown relinquishes already active sessions before closing", async () => {
    const first = await ready("active-at-close");
    await broker.close();
    expect(devices.sessions.size).toBe(0);
    expect(await broker.status("active-at-close")).toMatchObject({
      outcome: "released",
      sessionUuid: first,
      cleanupPending: false,
    });
  });
});
