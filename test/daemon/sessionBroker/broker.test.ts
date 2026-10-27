import { InMemoryMutationRecordingGaps } from "../../../src/daemon/sessionBroker/mutations/recordingGaps";
import { isSessionBrokerDeviceName } from "../../../src/daemon/sessionBroker/deviceNaming";
import { FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";
import { nativeProfile } from "../../../src/daemon/sessionBroker/profile";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { ResetFailureError } from "../../../src/daemon/sessionBroker/ResetFailureError";
import { SessionBrokerFailureError } from "../../../src/daemon/sessionBroker/devicePort";
import { ClientRequestCancellation } from "../../../src/daemon/socketServerParts/ClientRequestCancellation";
import * as brokerSupport from "../../../src/daemon/sessionBroker/brokerSupport";
import { SessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import { drainUntil, drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { parseSessionConfig, type SessionConfig } from "../../../src/devices/sessionConfig";
import { logger } from "../../../src/utils/logger";
import type { SessionBrokerReleaseResult } from "../../../src/devices/sessionBrokerResult";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import {
  androidCatalog,
  androidDefaults,
  IOS_DUO,
  iosCatalog,
  iosDefaults,
} from "../../devices/sessionRequirements/fixtures";

const OWNER: BindingProcessIdentity = {
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

describe("preparationFailureError", () => {
  test("preserves an untyped error when preparation was not aborted", () => {
    const error = new Error("native preparation failed");
    expect(brokerSupport.preparationFailureError(error, new AbortController().signal)).toBe(error);
  });

  test.each([new Error("broker stopped"), "broker stopped"])(
    "types aborted preparation using the signal reason %p",
    (reason) => {
      const controller = new AbortController();
      controller.abort(reason);
      const error = brokerSupport.preparationFailureError(
        new Error("native error"),
        controller.signal,
      );
      expect(error).toBeInstanceOf(SessionBrokerFailureError);
      expect(brokerSupport.failureFor(error)).toEqual({
        code: "cancelled",
        retryable: true,
        message: "Session preparation was cancelled: broker stopped",
      });
    },
  );

  test("preserves a typed failure object even when preparation was aborted", () => {
    const controller = new AbortController();
    controller.abort(new Error("broker stopped"));
    const error = new SessionBrokerFailureError({
      code: "timeout",
      retryable: true,
      message: "native preparation timeout",
    });
    expect(brokerSupport.preparationFailureError(error, controller.signal)).toBe(error);
  });
});

describe("session-only broker lifecycle", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;
  let ownerLive = true;

  beforeAll(async () => {
    // Warm SQLite/migration setup outside the per-test budget, as the shared DB harness does.
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    ownerLive = true;
    registry = await openSqliteBindingRegistry({
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
    const resource = devices.sessions.get(result.sessionUuid)!;
    const assignment = await registry.getAssignment({
      scopeKey: resource.scopeKey,
      bindingIndex: resource.allocationIndex,
    });
    expect(isSessionBrokerDeviceName(assignment!.deviceName!)).toBe(true);
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

  test("caller cancellation after device preparation persists a retryable receipt and cleans up", async () => {
    const controller = new AbortController();
    const prepare = devices.prepare.bind(devices);
    const prepareSpy = spyOn(devices, "prepare").mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args);
      controller.abort(new ClientRequestCancellation("client cancelled prepare"));
      return prepared;
    });
    const failed = await broker.prepare(
      config("cancel-checkpoint"),
      "owner-token",
      controller.signal,
    );
    expect(failed).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: {
        code: "cancelled",
        retryable: true,
        message: "Session preparation was cancelled: client cancelled prepare",
      },
    });
    expect(await broker.status("cancel-checkpoint")).toEqual(failed);
    expect(await broker.prepare(config("cancel-checkpoint"), "owner-token")).toEqual(failed);
    expect(devices.prepared).toHaveLength(1);
    expect(devices.destroyed).toEqual(devices.prepared);
    expect(devices.released).toEqual(["session-1"]);
    expect(devices.sessions.size).toBe(0);
    prepareSpy.mockRestore();
  });

  test("caller cancellation mid-acquire types an untyped native rejection using the abort reason", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    devices.prepareHook = async ({ signal }) => {
      const aborted = Promise.withResolvers<void>();
      signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await aborted.promise;
      throw new Error("native acquisition interrupted");
    };
    const pending = broker.prepare(config("cancel-acquire"), "owner-token", controller.signal);
    await entered.promise;
    controller.abort(new ClientRequestCancellation("RPC was cancelled"));
    const failed = await pending;
    expect(failed).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: {
        code: "cancelled",
        retryable: true,
        message: "Session preparation was cancelled: RPC was cancelled",
      },
    });
    expect(await broker.status("cancel-acquire")).toEqual(failed);
    expect(await broker.prepare(config("cancel-acquire"), "owner-token")).toEqual(failed);
    expect(devices.prepared).toHaveLength(1);
    expect(devices.destroyed).toEqual(devices.prepared);
    expect(devices.sessions.size).toBe(0);
  });

  test("typed preparation failures keep their own failure when the signal is aborted", async () => {
    const controller = new AbortController();
    const failure = { code: "spec_unsupported", retryable: false, message: "unsupported device" };
    devices.prepareHook = async () => {
      controller.abort(new ClientRequestCancellation("RPC was cancelled"));
      throw new SessionBrokerFailureError(failure);
    };
    const failed = await broker.prepare(config("typed-abort"), "owner-token", controller.signal);
    expect(failed).toMatchObject({ outcome: "failed", failure });
    expect(await broker.status("typed-abort")).toEqual(failed);
    expect(await broker.prepare(config("typed-abort"), "owner-token")).toEqual(failed);
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
    expect(await broker.release(uuid)).toMatchObject({ sessionUuid: uuid, outcome: "released" });
    expect(devices.destroyed).toHaveLength(1);
  });

  test.each([true, false])(
    "dead predecessor release converges without another drain (destroy=%s)",
    async (canDestroy) => {
      const uuid = await ready("interrupted-release");
      await options.store.beginRelease(uuid, OWNER);
      const resource = devices.sessions.get(uuid)!;
      // Model a restart after the native session drain, while reset is still outstanding.
      await registry.releaseExecution(
        { scopeKey: resource.scopeKey, bindingIndex: resource.allocationIndex },
        uuid,
      );
      ownerLive = false;
      devices.canDestroy = canDestroy;
      const owner = { ...OWNER, pid: 202, daemonId: "successor" };
      const successor = new SessionBroker({ ...options, owner });
      try {
        if (!canDestroy) {
          await successor.recoverReceipts();
          expect(await options.store.getRequest("interrupted-release")).toMatchObject({
            state: "releasing",
            owner,
          });
          expect(await options.store.getResource(resource.resourceId)).toMatchObject({
            state: "destroying",
          });
          expect(await successor.release(uuid)).toMatchObject({ outcome: "cleanup_pending" });
          expect(devices.released).toEqual([]);
          devices.canDestroy = true;
        }
        await successor.recover();
        expect(await options.store.getRequest("interrupted-release")).toMatchObject({
          state: "released",
          owner,
        });
        expect(await successor.status("interrupted-release")).toMatchObject({
          outcome: "released",
          cleanupPending: false,
        });
        expect(await successor.status("interrupted-release")).not.toHaveProperty("failure");
        expect(devices.destroyed).toEqual([resource.resourceId]);
        expect(devices.released).toEqual([]);
        expect(devices.resetResources).toEqual([]);
      } finally {
        await successor.close();
      }
    },
  );

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
    for (const field of [
      "bindingIndex",
      "managedHostScope",
      "localSlotCapacity",
      "runnerNamespace",
    ]) {
      expect(() => parseSessionConfig({ ...config("bad"), [field]: 1 })).toThrow(
        "Invalid session configuration",
      );
    }
    expect(() =>
      parseSessionConfig({
        ...config("bad"),
        device: { ...config("bad").device, bindingIndex: 0 },
      }),
    ).toThrow("invalid_request");
  });

  test("zero pooling creates fresh sessions and confirms destruction on release", async () => {
    const first = await ready("first");
    expect(await broker.hasActiveSession(first)).toBe(true);
    expect(await broker.release(first)).toMatchObject({ sessionUuid: first, outcome: "released" });
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
    const first = await ready("first");
    const second = await ready("second");
    devices.canDestroy = false;
    await broker.release(second);
    devices.canDestroy = true;
    const consulted: string[] = [];
    options.sessionDisposition = (sessionUuid) => {
      consulted.push(sessionUuid);
      throw new Error("request-specific recovery failure");
    };
    broker = new SessionBroker(options);
    await broker.recover();
    expect(consulted).toEqual([first]);
    expect(await broker.status("second")).toMatchObject({
      outcome: "released",
      cleanupPending: false,
    });
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

  test("foldable refusal precedes reservations and creation", async () => {
    options.catalog = async () => androidCatalog();
    options.defaults = () => androidDefaults();
    const request: SessionConfig = {
      ...config("fold-missing"),
      device: {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "foldable" },
        os: { kind: "omitted" },
      },
    };
    const result = await broker.prepare(request, "owner-token");
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "unsupported_hardware", retryable: false },
    });
    expect(JSON.stringify(result)).toContain("defaults.android.hardware.profiles");
    expect(await options.store.listResources()).toEqual([]);
    expect(devices.prepared).toEqual([]);
  });

  test.each([
    [undefined, 4096],
    [4096, undefined],
    [4096, 4096],
  ] as const)("idle fold RAM %s then %s", async (firstMemory, secondMemory) => {
    let memoryMb: number | undefined = firstMemory;
    options.catalog = async () =>
      androidCatalog({
        profiles: [
          { profileId: "pixel_9_pro_fold", archetype: "foldable", metadataState: "current" },
        ],
      });
    options.defaults = () =>
      androidDefaults({
        hardware: {
          omitted: "foldable",
          profiles: [
            {
              archetype: "foldable",
              profileId: "pixel_9_pro_fold",
              ...(memoryMb === undefined ? {} : { memoryMb }),
            },
          ],
        },
      });
    broker = new SessionBroker({ ...options, reuseAndroidCleanDevices: true });
    const request = (requestId: string): SessionConfig => ({
      ...config(requestId),
      device: {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "foldable" },
        os: { kind: "omitted" },
      },
    });
    const first = await broker.prepare(request("fold-first"), "owner-token");
    if (first.outcome !== "ready" || !first.sessionUuid) {
      throw new Error(JSON.stringify(first));
    }
    await broker.release(first.sessionUuid);
    memoryMb = secondMemory;
    const second = await broker.prepare(request("fold-second"), "owner-token");
    expect(second.outcome).toBe("ready");
    expect(devices.prepared[0] === devices.prepared[1]).toBe(firstMemory === secondMemory);
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

  test.each([false, true])(
    "acquisition waits on reset without claiming it and falls back on failure: %s",
    async (resetFails) => {
      const timer = new FakeTimer();
      timer.advanceTime(1000);
      await registry.close();
      registry = await openSqliteBindingRegistry({
        dbPath: ":memory:",
        timer,
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
      options.devices = devices;
      options.store = registry.sessionBrokerStore(
        scope.scope.scopeKey,
        new CountingIdGenerator("resource"),
      );
      options.timer = timer;
      options.reuseCleanDevices = true;
      options.limits = {
        totalDeviceCap: 2,
        sessionCap: 2,
        idlePoolCap: 1,
        maxConcurrentResetBoots: 1,
      };
      broker = new SessionBroker(options);
      const seed = await ready("seed");
      await broker.release(seed);
      const seedResource = (await options.store.listResources())[0];
      const profile = (await broker.status("seed"))?.profile;
      if (!profile) {
        throw new Error("Missing seed profile");
      }
      await options.store.recordTiming(
        "seed",
        {
          acquisition: {
            admission: "create",
            reuseCount: 0,
            outcome: "ready",
            startedAtMs: timer.now() - 600,
            completedAtMs: timer.now(),
            queueMs: 0,
            admissionWaitMs: 0,
            createMs: 200,
            bootMs: 400,
            totalMs: 600,
          },
          reset: {
            mode: "erase",
            outcome: "clean",
            phases: { stop: 20, erase: 30, boot: 50 },
            reuseCount: 0,
            startedAtMs: timer.now() - 100,
            completedAtMs: timer.now(),
            totalMs: 100,
          },
        },
        profile,
      );
      const second = await ready("second");
      const resetEntered = Promise.withResolvers<void>();
      const finishReset = Promise.withResolvers<"clean">();
      const resetSpy = spyOn(devices, "reset").mockImplementation(async () => {
        resetEntered.resolve();
        return finishReset.promise;
      });
      const pendingRelease = broker.release(second);
      await resetEntered.promise;
      const admittedWait = Promise.withResolvers<void>();
      const admit = options.store.admit.bind(options.store);
      const admissionSpy = spyOn(options.store, "admit").mockImplementation(async (input) => {
        const result = await admit(input);
        expect(result.kind).toBe("wait");
        admittedWait.resolve();
        return result;
      });
      try {
        const acquisition = broker.prepare(config("third"), "owner-token");
        await admittedWait.promise;
        expect(await options.store.getRequest("third")).toMatchObject({
          state: "acquiring",
          resourceId: null,
        });
        expect(await options.store.getResource(seedResource.resourceId)).toMatchObject({
          state: "resetting",
          requestId: "second",
        });
        expect(devices.prepared).toHaveLength(2);
        if (resetFails) {
          finishReset.reject(new Error("reset failed"));
        } else {
          finishReset.resolve("clean");
        }
        expect(await acquisition).toMatchObject({ outcome: "ready" });
        await pendingRelease;
        expect(devices.prepared).toHaveLength(3);
        expect(devices.prepared[2] === seedResource.resourceId).toBe(!resetFails);
        expect((await options.store.getRequest("third"))?.timing?.acquisition?.admission).toBe(
          resetFails ? "create" : "reuse",
        );
      } finally {
        finishReset.resolve("clean");
        admissionSpy.mockRestore();
        resetSpy.mockRestore();
      }
    },
  );

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

  test("capacity refusal is retryable under a new request ID; the old ID replays it identically", async () => {
    const holder = await ready("holder");
    const refusal = await broker.prepare(config("over-cap"), "owner-token");
    expect(refusal).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      failure: {
        code: "capacity_exhausted",
        retryable: true,
        retryRequires: "new_request_id",
      },
    });
    await broker.release(holder);
    expect(await broker.prepare(config("over-cap"), "owner-token")).toEqual(refusal);
    expect(await broker.status("over-cap")).toEqual(refusal);
    expect(await broker.prepare(config("over-cap-2"), "owner-token")).toMatchObject({
      outcome: "ready",
    });
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

  test("an enabled Duo capability admits an exact Duo request and advertises support", async () => {
    expect(broker.supportsIosDuo()).toBe(false);
    await broker.close();
    broker = new SessionBroker({
      ...options,
      limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 0 },
      capabilities: { iosDuo: true },
    });
    expect(broker.supportsIosDuo()).toBe(true);
    const request = config("duo-enabled");
    request.device.hardware = {
      kind: "exact-model",
      model: { namespace: "simulator-device-type", value: IOS_DUO.simulatorDeviceTypeIdentifier },
    };
    request.device.os = { kind: "exact", version: "28" };

    const result = await broker.prepare(request, "owner-token");

    expect(result.outcome).toBe("ready");
    expect(nativeProfile(devices.sessions.get(result.sessionUuid!)!)).toMatchObject({
      platform: "ios",
      simulatorDeviceTypeIdentifier: IOS_DUO.simulatorDeviceTypeIdentifier,
      archetype: "duo",
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

  test.each([false, true])(
    "reset capacity refusal (timing wrapper: %s) preserves the device until recovery",
    async (wrapped) => {
      broker = new SessionBroker({ ...options, reuseCleanDevices: true });
      const first = await ready("first");
      const refusal = new BootCapacityExhaustedError(
        { platform: "ios", limit: 1, booted: 1, retryAfterMs: 5_000 },
        "iOS simulator capacity exhausted",
      );
      devices.resetError = wrapped
        ? new ResetFailureError(
            "boot capacity exhausted",
            {
              outcome: "pending",
              mode: "erase",
              phases: { erase: 3, boot: 0 },
            },
            { cause: refusal },
          )
        : refusal;

      expect(await broker.release(first)).toMatchObject({
        sessionUuid: first,
        outcome: "cleanup_pending",
      });
      expect((await options.store.getRequest("first"))?.state).toBe("releasing");
      expect((await options.store.listResources())[0].state).toBe("resetting");
      expect(devices.destroyed).toEqual([]);
      expect(await broker.status("first")).toMatchObject({ cleanupPending: true });
      await broker.recover();
      expect(devices.resetResources).toHaveLength(2);
      expect((await options.store.getRequest("first"))?.state).toBe("releasing");
      expect((await options.store.listResources())[0].state).toBe("resetting");
      expect(devices.destroyed).toEqual([]);

      devices.resetError = undefined;
      await broker.recover();
      expect(devices.resetResources).toHaveLength(3);
      expect((await options.store.listResources())[0].state).toBe("idle");
      expect(await broker.release(first)).toMatchObject({ outcome: "released" });
      await ready("second");
      expect(devices.prepared[1]).toBe(devices.prepared[0]);
      expect(devices.destroyed).toEqual([]);
    },
  );

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
    expect(await pending).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: {
        code: "session_broker_stopping",
        retryable: true,
        retryAfterMs: 5_000,
        retryRequires: "new_request_id",
      },
    });
    await close;
    expect(devices.sessions.size).toBe(0);
    await expect(broker.prepare(config("late"), "owner-token")).rejects.toThrow("stopping");
  });

  describe("bounded release reply", () => {
    const replyBudgetMs = 20;
    let timer: FakeTimer;

    beforeEach(() => {
      timer = new FakeTimer();
      broker = new SessionBroker({ ...options, timer, releaseReplyBudgetMs: replyBudgetMs });
    });

    async function replyAfterBudget(pending: Promise<SessionBrokerReleaseResult>) {
      let result: SessionBrokerReleaseResult | undefined;
      const observed = pending.then((value) => {
        result = value;
      });
      await drainUntilQuiescent(timer);
      timer.advanceTime(replyBudgetMs);
      await drainUntil(() => result !== undefined, { description: "bounded release reply" });
      await observed;
      return result;
    }

    test.each(["active", "releasing"] as const)(
      "recovery keeps its slot on full cleanup for %s requests beyond the RPC budget",
      async (state) => {
        options.limits = { totalDeviceCap: 2, sessionCap: 2 };
        options.sessionDisposition = () => "gone";
        broker = new SessionBroker({
          ...options,
          timer,
          releaseReplyBudgetMs: replyBudgetMs,
          cleanupConcurrency: 1,
          cleanupWaitMs: 100,
        });
        const first = await ready("a-recovery");
        const second = await ready("b-recovery");
        if (state === "releasing") {
          await options.store.beginRelease(first, OWNER);
          await options.store.beginRelease(second, OWNER);
        }
        const entered = Promise.withResolvers<void>();
        const complete = Promise.withResolvers<void>();
        devices.releaseHook = async () => {
          entered.resolve();
          await complete.promise;
        };
        let recovered = false;
        const recovering = broker.recover().then(() => {
          recovered = true;
        });
        await entered.promise;
        try {
          await drainUntilQuiescent(timer);
          timer.advanceTime(replyBudgetMs * 2);
          await drainUntilQuiescent(timer);
          expect(devices.released).toEqual([first]);
          expect(recovered).toBe(false);
          expect(timer.getPendingTimeouts()).toEqual([100]);
          // End the pass's own wait. The occupied native slot must survive into later passes.
          timer.advanceTime(100);
          await recovering;
          expect(recovered).toBe(true);
          await broker.recoverCleanup();
          expect(devices.released).toEqual([first]);
        } finally {
          complete.resolve();
          await recovering;
          await broker.joinReleases();
        }
        await broker.recoverCleanup();
        expect(devices.released).toEqual([first, second]);
        expect(await broker.status("b-recovery")).toMatchObject({ outcome: "released" });
      },
    );

    test("an RPC joins recovery's full release and close preserves its abort signal", async () => {
      broker = new SessionBroker({ ...options, timer, cleanupWaitMs: 100 });
      const uuid = await ready("recovery-rpc");
      await options.store.beginRelease(uuid, OWNER);
      const begin = spyOn(options.store, "beginRelease");
      const entered = Promise.withResolvers<AbortSignal>();
      const complete = Promise.withResolvers<void>();
      const destroy = spyOn(options.devices, "destroy").mockImplementation(
        async (_resource, signal) => {
          if (!signal) {
            throw new Error("Recovery destroy lost its abort signal");
          }
          entered.resolve(signal);
          await complete.promise;
          signal.throwIfAborted();
          return "pending";
        },
      );
      const recovering = broker.recoverCleanup();
      const signal = await entered.promise;
      let closing: Promise<void> | undefined;
      try {
        expect(begin).toHaveBeenCalledTimes(1);
        const reply = broker.release(uuid, undefined, { replyBudgetMs });
        expect(await replyAfterBudget(reply)).toMatchObject({ outcome: "cleanup_pending" });
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(begin).toHaveBeenCalledTimes(1);
        expect(devices.released).toEqual([uuid]);
        let closed = false;
        closing = broker.close().then(() => {
          closed = true;
        });
        await drainUntil(() => signal.aborted, { description: "recovery cleanup aborted" });
        await drainUntilQuiescent(timer);
        expect(closed).toBe(false);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        complete.resolve();
        await recovering;
        await closing;
        await broker.joinReleases();
        destroy.mockRestore();
        begin.mockRestore();
      }
      expect(await broker.status("recovery-rpc")).toMatchObject({ cleanupPending: true });
    });

    test("per-call reply budgets bound concurrent callers independently", async () => {
      const uuid = await ready("per-call");
      const entered = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      devices.releaseHook = async () => {
        entered.resolve();
        await complete.promise;
      };
      const short = broker.release(uuid, undefined, { replyBudgetMs: 5 });
      await entered.promise;
      let longReplied = false;
      const long = broker.release(uuid, undefined, { replyBudgetMs: 10 }).then((result) => {
        longReplied = true;
        return result;
      });
      try {
        await drainUntilQuiescent(timer);
        expect(timer.getPendingTimeouts()).toEqual([5, 10]);
        timer.advanceTime(5);
        expect(await short).toEqual({ sessionUuid: uuid, outcome: "cleanup_pending" });
        expect(longReplied).toBe(false);
        timer.advanceTime(5);
        expect(await long).toEqual({ sessionUuid: uuid, outcome: "cleanup_pending" });
        expect(devices.released).toEqual([uuid]);
      } finally {
        complete.resolve();
        await Promise.all([short, long, broker.joinReleases()]);
      }
    });

    test.each(["reset", "destroy"] as const)(
      "hanging %s replies pending, keeps durable ownership, and joins cleanup",
      async (operation) => {
        broker = new SessionBroker({
          ...options,
          timer,
          releaseReplyBudgetMs: replyBudgetMs,
          reuseCleanDevices: operation === "reset",
        });
        const uuid = await ready("bounded");
        const entered = Promise.withResolvers<void>();
        const complete = Promise.withResolvers<void>();
        const reset = devices.reset.bind(devices);
        const destroy = devices.destroy.bind(devices);
        const resetSpy = spyOn(devices, "reset").mockImplementation(async (resource) => {
          if (operation === "reset") {
            entered.resolve();
            await complete.promise;
          }
          return reset(resource);
        });
        const destroySpy = spyOn(devices, "destroy").mockImplementation(async (resource) => {
          if (operation === "destroy") {
            entered.resolve();
            await complete.promise;
          }
          return destroy(resource);
        });
        const pending = broker.release(uuid);
        await entered.promise;
        let joined = false;
        const joining = broker.joinReleases().then(() => {
          joined = true;
        });
        try {
          expect(await replyAfterBudget(pending)).toMatchObject({
            sessionUuid: uuid,
            outcome: "cleanup_pending",
          });
          expect(joined).toBe(false);
          expect((await options.store.getRequest("bounded"))?.state).toBe("releasing");
          expect((await options.store.listResources())[0].state).toBe(
            operation === "reset" ? "resetting" : "destroying",
          );
          expect(operation === "reset" ? resetSpy : destroySpy).toHaveBeenCalledTimes(1);
        } finally {
          complete.resolve();
          await joining;
          resetSpy.mockRestore();
          destroySpy.mockRestore();
        }
        expect(await broker.status("bounded")).toMatchObject({
          outcome: "released",
          cleanupPending: false,
        });
        expect(await broker.release(uuid)).toMatchObject({
          sessionUuid: uuid,
          outcome: "released",
        });
        expect(timer.getPendingTimeoutCount()).toBe(0);
      },
    );

    test("work completing within the reply budget returns released and clears its timer", async () => {
      const uuid = await ready("quick");
      expect(await broker.release(uuid)).toMatchObject({ sessionUuid: uuid, outcome: "released" });
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(await broker.status("quick")).toMatchObject({ outcome: "released" });
    });

    test("concurrent and later callers get bounded replies from the same native work", async () => {
      const uuid = await ready("concurrent");
      const entered = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      devices.releaseHook = async () => {
        entered.resolve();
        await complete.promise;
      };
      const first = broker.release(uuid);
      await entered.promise;
      const second = broker.release(uuid);
      try {
        expect(
          await replyAfterBudget(
            Promise.all([first, second]).then(([result, other]) => {
              expect(other).toEqual(result);
              return result;
            }),
          ),
        ).toEqual({ sessionUuid: uuid, outcome: "cleanup_pending" });
        expect(await replyAfterBudget(broker.release(uuid))).toEqual({
          sessionUuid: uuid,
          outcome: "cleanup_pending",
        });
        expect(devices.released).toEqual([uuid]);
      } finally {
        complete.resolve();
        await broker.joinReleases();
      }
    });

    test("a late release rejection is warned, handled, and removed from tracking", async () => {
      const uuid = await ready("late-failure");
      const entered = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      devices.releaseHook = async () => {
        entered.resolve();
        await complete.promise;
      };
      // Native errors already have their own warn-and-recover paths. Fail a durable cleanup
      // read to exercise a rejection of the tracked release promise itself.
      const error = new Error("late receipt read failed");
      const read = spyOn(options.store, "getResource");
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      const pending = broker.release(uuid);
      await entered.promise;
      try {
        expect(await replyAfterBudget(pending)).toMatchObject({ outcome: "cleanup_pending" });
        read.mockRejectedValue(error);
        complete.resolve();
        await broker.joinReleases();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("release failed"), error);
        read.mockRestore();
        // A stale rejected entry would reject this retry instead of finishing cleanup.
        expect(await broker.release(uuid)).toMatchObject({ outcome: "released" });
        // Unhandled-rejection reporting needs an event-loop turn after the late rejection.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        complete.resolve();
        read.mockRestore();
        await broker.joinReleases();
        warn.mockRestore();
        process.off("unhandledRejection", onUnhandled);
      }
    });

    test.each(["commit", "cleanup"] as const)(
      "%s rejection before the reply budget still propagates",
      async (stage) => {
        const uuid = await ready("early-failure");
        const error = new Error("begin release failed");
        const begin = spyOn(options.store, "beginRelease");
        const read = spyOn(options.store, "getResource");
        if (stage === "commit") {
          begin.mockRejectedValueOnce(error);
        } else {
          read.mockRejectedValueOnce(error);
        }
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          await expect(broker.release(uuid)).rejects.toBe(error);
          expect(timer.getPendingTimeoutCount()).toBe(0);
          expect((await options.store.getRequest("early-failure"))?.state).toBe(
            stage === "commit" ? "active" : "releasing",
          );
        } finally {
          begin.mockRestore();
          read.mockRestore();
          warn.mockRestore();
        }
      },
    );

    test("reply budget cannot acknowledge a release before its durable commit", async () => {
      const uuid = await ready("slow-commit");
      const complete = Promise.withResolvers<void>();
      const original = options.store.beginRelease.bind(options.store);
      const begin = spyOn(options.store, "beginRelease").mockImplementation(async (...args) => {
        await complete.promise;
        return original(...args);
      });
      let replied = false;
      const pending = broker.release(uuid).then((result) => {
        replied = true;
        return result;
      });
      try {
        timer.advanceTime(replyBudgetMs);
        expect((await options.store.getRequest("slow-commit"))?.state).toBe("active");
        expect(timer.getPendingTimeoutCount()).toBe(0);
        expect(replied).toBe(false);
      } finally {
        complete.resolve();
        await pending;
        begin.mockRestore();
      }
      expect(await pending).toMatchObject({ outcome: "released" });
    });

    test("close joins native work even after a pending reply", async () => {
      const uuid = await ready("close-pending");
      const entered = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      devices.releaseHook = async () => {
        entered.resolve();
        await complete.promise;
      };
      const pending = broker.release(uuid);
      await entered.promise;
      let closed = false;
      let closing: Promise<void> | undefined;
      const snapshots = spyOn(options.store, "listRecoverableRequests");
      try {
        expect(await replyAfterBudget(pending)).toMatchObject({ outcome: "cleanup_pending" });
        closing = broker.close().then(() => {
          closed = true;
        });
        // Finish the handoff scan: close has reached its join, not merely its first await.
        await drainUntil(() => snapshots.mock.calls.length === 3, {
          description: "close release join",
        });
        timer.advanceTime(replyBudgetMs);
        await options.store.listRecoverableRequests();
        expect(timer.getPendingTimeoutCount()).toBe(0);
        expect(closed).toBe(false);
      } finally {
        complete.resolve();
        await closing;
        await broker.joinReleases();
        snapshots.mockRestore();
      }
      expect(closed).toBe(true);
      expect(await broker.status("close-pending")).toMatchObject({ outcome: "released" });
    });
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
    // Each caller may have its own bounded wait; the native drain remains shared.
    complete.resolve();
    expect(await a).toMatchObject({ outcome: "released" });
    expect(await b).toMatchObject({ outcome: "released" });
    expect(releases).toBe(1);
  });

  test("shutdown keeps active sessions for the restarted provider instead of releasing them", async () => {
    const first = await ready("active-at-close");
    await broker.close();
    expect(devices.released).toEqual([]);
    expect(devices.destroyed).toEqual([]);
    expect(devices.sessions.has(first)).toBe(true);
    expect(await options.store.getRequest("active-at-close")).toMatchObject({
      state: "active",
      restartHandoff: true,
      owner: OWNER,
    });
    expect(await broker.status("active-at-close")).toMatchObject({
      outcome: "ready",
      sessionUuid: first,
      cleanupPending: false,
    });
  });

  test("service stop commits every active handoff before a blocked recovery release settles", async () => {
    options.limits = { totalDeviceCap: 3, sessionCap: 3 };
    const expired = await ready("a-expired");
    const live = await ready("b-live");
    const otherLive = await ready("c-live");
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    devices.releaseHook = async () => {
      entered.resolve();
      await complete.promise;
    };
    options.sessionDisposition = (sessionId) => (sessionId === expired ? "gone" : "live");
    const timer = new FakeTimer();
    let lockReleased = false;
    const service = new SessionBrokerService(
      broker,
      "test-scope",
      {
        acquire: () => {},
        release: () => {
          lockReleased = true;
        },
      },
      timer,
      new InMemoryMutationRecordingGaps(),
    );
    const marked: string[] = [];
    const relinquish = options.store.relinquishForRestart.bind(options.store);
    const mark = spyOn(options.store, "relinquishForRestart").mockImplementation(
      async (id, owner) => {
        const result = await relinquish(id, owner);
        marked.push(id);
        return result;
      },
    );
    service.start();
    await entered.promise;
    const closing = service.close();
    try {
      await drainUntil(() => marked.length === 2, { description: "committed active handoffs" });
      for (const id of ["b-live", "c-live"]) {
        expect(await options.store.getRequest(id)).toMatchObject({
          state: "active",
          restartHandoff: true,
        });
      }
      expect((await options.store.getRequest("a-expired"))?.restartHandoff).toBeUndefined();
      expect(devices.released).toEqual([expired]);
      expect(devices.sessions.has(live)).toBe(true);
      expect(devices.sessions.has(otherLive)).toBe(true);
      expect(lockReleased).toBe(false);
    } finally {
      complete.resolve();
      await closing;
      mark.mockRestore();
    }
    expect(lockReleased).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("shutdown marks active handoffs before an aborted preparation settles", async () => {
    options.limits = { totalDeviceCap: 2, sessionCap: 2 };
    await ready("active-before-prepare");
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    devices.prepareHook = async ({ signal }) => {
      signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await complete.promise;
    };
    const pending = broker.prepare(config("blocked-prepare"), "owner-token");
    await entered.promise;
    let marked = false;
    const relinquish = options.store.relinquishForRestart.bind(options.store);
    const mark = spyOn(options.store, "relinquishForRestart").mockImplementation(
      async (id, owner) => {
        const result = await relinquish(id, owner);
        marked = true;
        return result;
      },
    );
    let closed = false;
    const closing = broker.close().then(() => {
      closed = true;
    });
    try {
      await aborted.promise;
      await drainUntil(() => marked, { description: "handoff before preparation joins" });
      expect(await options.store.getRequest("active-before-prepare")).toMatchObject({
        state: "active",
        restartHandoff: true,
      });
      expect((await options.store.getRequest("blocked-prepare"))?.restartHandoff).toBeUndefined();
      expect(closed).toBe(false);
    } finally {
      complete.resolve();
      await pending;
      await closing;
      mark.mockRestore();
    }
    expect(await broker.status("blocked-prepare")).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
    });
  });

  test("a stale shutdown snapshot cannot mark a request that becomes terminal", async () => {
    const session = await ready("terminal-during-mark");
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const relinquish = options.store.relinquishForRestart.bind(options.store);
    const mark = spyOn(options.store, "relinquishForRestart").mockImplementation(
      async (id, owner) => {
        entered.resolve();
        await complete.promise;
        return relinquish(id, owner);
      },
    );
    const closing = broker.close();
    await entered.promise;
    try {
      await broker.release(session);
      expect((await options.store.getRequest("terminal-during-mark"))?.state).toBe("released");
    } finally {
      complete.resolve();
      await closing;
      mark.mockRestore();
    }
    expect(
      (await options.store.getRequest("terminal-during-mark"))?.restartHandoff,
    ).toBeUndefined();
  });

  test("service stop leaves queued native releases durable and skips retention", async () => {
    options.cleanupConcurrency = 1;
    broker = new SessionBroker(options);
    options.limits = { totalDeviceCap: 2, sessionCap: 2 };
    const first = await ready("a-expired");
    const second = await ready("b-expired");
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    devices.releaseHook = async () => {
      entered.resolve();
      await complete.promise;
    };
    const dispositions: string[] = [];
    options.sessionDisposition = (id) => {
      dispositions.push(id);
      return "gone";
    };
    const prune = spyOn(broker, "pruneReceipts");
    const timer = new FakeTimer();
    const service = new SessionBrokerService(
      broker,
      "test-scope",
      { acquire: () => {}, release: () => {} },
      timer,
      new InMemoryMutationRecordingGaps(),
    );
    service.start();
    await entered.promise;
    const closing = service.close();
    try {
      complete.resolve();
      await closing;
      expect(dispositions).toEqual([first, second]);
      expect(devices.released).toEqual([first]);
      expect(devices.sessions.has(second)).toBe(true);
      expect(prune).not.toHaveBeenCalled();
    } finally {
      prune.mockRestore();
    }
  });

  test("shutdown stops queued resource cleanup and fences late destruction confirmation", async () => {
    options.cleanupConcurrency = 1;
    broker = new SessionBroker(options);
    options.limits = { totalDeviceCap: 2, sessionCap: 2 };
    const first = await ready("a-failed");
    const second = await ready("b-failed");
    await options.store.fail("a-failed", OWNER, "failed session");
    await options.store.fail("b-failed", OWNER, "failed session");
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    devices.releaseHook = async () => {
      entered.resolve();
      await complete.promise;
    };
    const recovering = broker.recover();
    await entered.promise;
    const closing = broker.close();
    complete.resolve();
    await Promise.all([recovering, closing]);
    expect(devices.released).toEqual([first]);
    expect(devices.sessions.has(second)).toBe(true);
    expect(
      (await options.store.listResources()).filter((resource) => resource.state === "destroying"),
    ).toHaveLength(2);
  });

  test("repeated shutdown marking is idempotent and preserves the active grant", async () => {
    const session = await ready("double-handoff");
    await broker.markRestartHandoff();
    const once = await options.store.getRequest("double-handoff");
    await broker.markRestartHandoff();
    await broker.close();
    expect(await options.store.getRequest("double-handoff")).toEqual(once);
    expect(once).toMatchObject({
      state: "active",
      restartHandoff: true,
      sessionId: session,
      owner: OWNER,
    });
    expect(devices.released).toEqual([]);
    expect(devices.destroyed).toEqual([]);
  });

  describe("provider restart (#12451)", () => {
    const SUCCESSOR: BindingProcessIdentity = {
      daemonId: "successor",
      pid: 202,
      processGenerationToken: "start-b",
    };

    function successor(disposition: "live" | "recoverable-handoff" | "gone") {
      return new SessionBroker({
        ...options,
        owner: SUCCESSOR,
        sessionDisposition: () => disposition,
      });
    }

    /** What the restarted daemon's execution reowner does for a rehydrated managed session. */
    async function reownNatively(sessionUuid: string) {
      const resource = devices.sessions.get(sessionUuid)!;
      const key = { scopeKey: resource.scopeKey, bindingIndex: resource.allocationIndex };
      const assignment = (await registry.getAssignment(key))!;
      const claimed = await registry.claimExecution(key, assignment, {
        ...SUCCESSOR,
        sessionUuid,
      });
      expect(claimed.kind).toBe("claimed");
    }

    test("graceful restart adopts the same session once its binding is re-owned", async () => {
      const uuid = await ready("graceful");
      await broker.close();
      ownerLive = false;
      const next = successor("live");
      // Rehydrated but not yet re-owned natively: nothing is released or terminalized.
      await next.recover();
      expect(await options.store.getRequest("graceful")).toMatchObject({
        state: "active",
        owner: OWNER,
        restartHandoff: true,
      });
      expect(await next.hasActiveSession(uuid)).toBe(false);
      await reownNatively(uuid);
      await next.recover();
      const adopted = await options.store.getRequest("graceful");
      expect(adopted).toMatchObject({ state: "active", owner: SUCCESSOR, sessionId: uuid });
      expect(adopted?.restartHandoff).toBeUndefined();
      expect(await next.ownedStatus("graceful", "owner-token")).toMatchObject({
        outcome: "ready",
        sessionUuid: uuid,
        cleanupPending: false,
      });
      expect(await next.hasActiveSession(uuid)).toBe(true);
      expect(devices.released).toEqual([]);
      expect(devices.destroyed).toEqual([]);
      // The adopted session still ends through the consumer's ordinary release.
      expect(await next.release(uuid)).toMatchObject({ sessionUuid: uuid, outcome: "released" });
      expect(devices.destroyed).toHaveLength(1);
      await next.close();
    });

    test("a restart reservation that is still valid is adopted too", async () => {
      const uuid = await ready("reserved");
      await broker.close();
      ownerLive = false;
      await reownNatively(uuid);
      const next = successor("recoverable-handoff");
      await next.recover();
      expect(await next.status("reserved")).toMatchObject({ outcome: "ready", sessionUuid: uuid });
      expect(devices.destroyed).toEqual([]);
      await next.close();
    });

    test("graceful handoff whose session did not survive is terminal, never a release", async () => {
      const uuid = await ready("lost-handoff");
      await broker.close();
      ownerLive = false;
      const next = successor("gone");
      await next.recover();
      expect(await next.status("lost-handoff")).toMatchObject({
        outcome: "failed",
        sessionUuid: uuid,
        failure: { code: "session_owner_exited" },
      });
      expect(devices.destroyed).toHaveLength(1);
      await next.close();
    });

    test("a crashed owner never relinquished, so its session is retired", async () => {
      const uuid = await ready("crashed");
      ownerLive = false;
      await reownNatively(uuid);
      const next = successor("live");
      await next.recover();
      expect(await next.status("crashed")).toMatchObject({
        outcome: "failed",
        sessionUuid: uuid,
        failure: { code: "session_owner_exited" },
      });
      expect(devices.destroyed).toHaveLength(1);
      await next.close();
    });

    test("a still-live previous owner is never adopted from", async () => {
      const uuid = await ready("live-owner");
      await broker.close();
      await reownNatively(uuid);
      const next = successor("live");
      await next.recover();
      expect(await options.store.getRequest("live-owner")).toMatchObject({
        state: "active",
        owner: OWNER,
      });
      await next.close();
    });
  });
});
