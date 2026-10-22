import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import { SessionBrokerFailureError } from "../../../src/daemon/sessionBroker/devicePort";
import { SessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { ActionableError } from "../../../src/models/ActionableError";
import { SessionBrokerStoppingError } from "../../../src/daemon/sessionBroker/SessionBrokerStoppingError";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { logger } from "../../../src/utils/logger";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";
import { drainUntil } from "../../helpers/fakeTimerStepping";

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

describe("preparations crossing restart handoff", () => {
  let registry: SqliteBindingRegistry;
  let store: SqliteSessionBrokerStore;
  let devices: FakeNativePort;
  let broker: SessionBroker;
  let timer: FakeTimer;

  beforeAll(async () => {
    await (await openSqliteBindingRegistry({ dbPath: ":memory:" })).close();
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: () => true,
    });
    const scope = await registry.ensureScope({
      managedHostScope: "shutdown-host",
      runnerNamespace: "shutdown-broker",
      runnerIncarnation: "persistent",
    });
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    store = registry.sessionBrokerStore(scope.scope.scopeKey, new CountingIdGenerator("resource"));
    devices = new FakeNativePort(registry);
    broker = newBroker();
  });

  function newBroker(catalog: SessionBrokerOptions["catalog"] = async () => iosCatalog()) {
    return new SessionBroker({
      store,
      devices,
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 0 },
      catalog,
      defaults: () => iosDefaults(),
      sessionDisposition: () => "live",
      timer,
    });
  }

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  function service(release: () => void = () => {}) {
    return new SessionBrokerService(
      broker,
      "shutdown-scope",
      { acquire: () => {}, release },
      timer,
    );
  }

  async function stopNativePreparation(requestId: string) {
    const entered = Promise.withResolvers<void>();
    devices.prepareHook = async ({ signal }) => {
      const aborted = Promise.withResolvers<void>();
      signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await aborted.promise;
      throw new SessionBrokerFailureError({
        code: "provision_failed",
        retryable: false,
        message:
          "provisionDevice request was cancelled by the caller; its provisioning work was cancelled too.",
      });
    };
    const preparing = broker.prepare(config(requestId), "owner");
    await entered.promise;
    await broker.close();
    return preparing;
  }

  test("T1: broker shutdown preserves stopping retryability through native provision failure", async () => {
    expect(await stopNativePreparation("stop-mid-provision")).toMatchObject({
      outcome: "failed",
      failure: {
        code: "session_broker_stopping",
        retryable: true,
        retryAfterMs: 5_000,
        retryRequires: "new_request_id",
      },
    });
    expect(await store.getRequest("stop-mid-provision")).toMatchObject({
      errorCode: "session_broker_stopping",
      retryable: true,
    });
  });

  test.each([false, true])(
    "T2: successor replays identical stopping failure with cleanupPending=%s",
    async (cleanupPending) => {
      devices.canDestroy = !cleanupPending;
      const initial = await stopNativePreparation("stop-replay");
      expect(initial.cleanupPending).toBe(cleanupPending);
      broker = newBroker();
      const replay = await broker.prepare(config("stop-replay"), "owner");
      expect(replay.failure).toEqual(initial.failure);
      expect(replay).toMatchObject({
        outcome: "failed",
        cleanupPending,
        failure: {
          code: "session_broker_stopping",
          retryable: true,
          retryAfterMs: 5_000,
          retryRequires: "new_request_id",
        },
      });
      expect(devices.prepared).toHaveLength(1);
    },
  );

  test("T3: shutdown before admission refuses without storing a receipt", async () => {
    const entered = Promise.withResolvers<void>();
    broker = newBroker(async (_platform, signal) => {
      const aborted = Promise.withResolvers<void>();
      signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await aborted.promise;
      throw signal!.reason;
    });
    const preparing = broker.prepare(config("stop-before-admission"), "owner");
    const settled = Promise.allSettled([preparing]);
    await entered.promise;
    await broker.markRestartHandoff();
    await settled;
    await expect(preparing).rejects.toBeInstanceOf(SessionBrokerStoppingError);
    expect(await store.getRequest("stop-before-admission")).toBeUndefined();
    expect(devices.prepared).toEqual([]);
  });

  test.each(["prepare", "abandon"] as const)(
    "stopping refuses %s before touching durable request identity",
    async (operation) => {
      await broker.markRestartHandoff();
      const expected = {
        message: "Session broker is stopping",
        code: "session_broker_stopping",
        retryable: true,
        retryAfterMs: 5_000,
      };
      const pending =
        operation === "prepare"
          ? broker.prepare(config("stopping-request"), "owner")
          : broker.abandon("stopping-request", "owner");
      await expect(pending).rejects.toBeInstanceOf(ActionableError);
      await expect(pending).rejects.toBeInstanceOf(SessionBrokerStoppingError);
      await expect(pending).rejects.toMatchObject(expected);
      expect(await store.getRequest("stopping-request")).toBeUndefined();
      expect(devices.prepared).toEqual([]);
    },
  );

  test("broker close joins preparations and releases after its first handoff snapshot fails", async () => {
    const ready = await broker.prepare(config("release-before-close"), "release-owner");
    expect(ready.outcome).toBe("ready");
    const releaseEntered = Promise.withResolvers<void>();
    const finishRelease = Promise.withResolvers<void>();
    devices.releaseHook = async () => {
      releaseEntered.resolve();
      await finishRelease.promise;
    };
    const releasing = broker.release(ready.sessionUuid!);
    await releaseEntered.promise;
    devices.releaseHook = undefined;

    const preparationEntered = Promise.withResolvers<AbortSignal | undefined>();
    const finishPreparation = Promise.withResolvers<void>();
    devices.prepareHook = async ({ signal }) => {
      preparationEntered.resolve(signal);
      await finishPreparation.promise;
    };
    const preparing = broker.prepare(config("prepare-before-close"), "prepare-owner");
    const signal = await preparationEntered.promise;
    const failure = new Error("handoff snapshot unavailable");
    const snapshot = spyOn(store, "listRecoverableRequests").mockRejectedValueOnce(failure);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    let closed = false;
    const closing = Promise.allSettled([broker.close()]).then((results) => {
      closed = true;
      return results;
    });
    try {
      expect(signal?.aborted).toBe(true);
      // A durable read is also a deterministic async checkpoint for close's rejected snapshot.
      await store.getRequest("prepare-before-close");
      expect(closed).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        "Session broker restart handoff failed: handoff snapshot unavailable",
        failure,
      );
      finishPreparation.resolve();
      expect(await preparing).toMatchObject({
        outcome: "failed",
        // Shutdown stores a stopping receipt requiring a fresh request identity.
        failure: {
          code: "session_broker_stopping",
          retryable: true,
          retryAfterMs: 5_000,
          retryRequires: "new_request_id",
        },
      });
      expect(closed).toBe(false);
      finishRelease.resolve();
      expect(await closing).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(snapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(await releasing).toMatchObject({ outcome: "released" });
      expect(devices.sessions.size).toBe(0);
    } finally {
      finishPreparation.resolve();
      finishRelease.resolve();
      await Promise.all([preparing, releasing, closing]);
      snapshot.mockRestore();
      warning.mockRestore();
    }
  });

  test.each(["service", "broker"] as const)(
    "%s close marks a late activation before joining other preparations or recovery",
    async (entry) => {
      const nativeEntered = Promise.withResolvers<AbortSignal | undefined>();
      const finishNative = Promise.withResolvers<void>();
      devices.prepareHook = async ({ livenessOwnerToken, signal }) => {
        if (livenessOwnerToken === "blocked-owner") {
          nativeEntered.resolve(signal);
          await finishNative.promise;
        }
      };
      const nativePending = broker.prepare(config("native-pending"), "blocked-owner");
      const signal = await nativeEntered.promise;

      // Pause before the real activation transaction commits, after the abort check. Its
      // commit will miss the first handoff snapshot, while another preparation keeps close open.
      const activationEntered = Promise.withResolvers<void>();
      const finishActivation = Promise.withResolvers<void>();
      const activate = store.activate.bind(store);
      const activation = spyOn(store, "activate").mockImplementationOnce(async (...args) => {
        activationEntered.resolve();
        await finishActivation.promise;
        return activate(...args);
      });
      const activating = broker.prepare(config("activation-pending"), "activation-owner");
      await activationEntered.promise;

      const recoveryEntered = Promise.withResolvers<void>();
      const finishRecovery = Promise.withResolvers<void>();
      let recoverySettled = false;
      const recovery = spyOn(broker, "recoverReceipts").mockImplementationOnce(async () => {
        recoveryEntered.resolve();
        await finishRecovery.promise;
        recoverySettled = true;
      });
      const host = service();
      if (entry === "service") {
        host.start();
        await recoveryEntered.promise;
      }

      const firstMark = Promise.withResolvers<void>();
      const mark = broker.markRestartHandoff.bind(broker);
      const marking = spyOn(broker, "markRestartHandoff").mockImplementationOnce(async () => {
        await mark();
        firstMark.resolve();
      });
      let closed = false;
      const closing = (entry === "service" ? host.close() : broker.close()).then(() => {
        closed = true;
      });
      try {
        await firstMark.promise;
        expect((await store.getRequest("activation-pending"))?.state).toBe("acquiring");
        finishActivation.resolve();
        expect(await activating).toMatchObject({ outcome: "ready" });
        expect(await store.getRequest("activation-pending")).toMatchObject({
          state: "active",
          restartHandoff: true,
        });
        expect(signal?.aborted).toBe(true);
        expect(closed).toBe(false);
        expect(recoverySettled).toBe(false);

        // Native work ignores cancellation until it completes. The broker must still prevent
        // it from activating during the service's recovery wait (or close's preparation join).
        finishNative.resolve();
        expect(await nativePending).toMatchObject({ outcome: "failed", cleanupPending: false });
        expect((await store.getRequest("native-pending"))?.restartHandoff).toBeUndefined();
        expect(recoverySettled).toBe(false);
      } finally {
        finishActivation.resolve();
        finishNative.resolve();
        finishRecovery.resolve();
        await Promise.all([activating, nativePending, closing]);
        activation.mockRestore();
        recovery.mockRestore();
        marking.mockRestore();
      }
      expect(devices.sessions.size).toBe(1);
    },
  );

  test("service stop aborts preparation before waiting for recovery", async () => {
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const finish = Promise.withResolvers<void>();
    devices.prepareHook = async ({ signal }) => {
      entered.resolve(signal);
      await finish.promise;
    };
    const pending = broker.prepare(config("abort-before-join"), "owner");
    const signal = await entered.promise;
    const recoveryEntered = Promise.withResolvers<void>();
    const finishRecovery = Promise.withResolvers<void>();
    const recovery = spyOn(broker, "recoverReceipts").mockImplementationOnce(async () => {
      recoveryEntered.resolve();
      await finishRecovery.promise;
    });
    const host = service();
    host.start();
    await recoveryEntered.promise;
    const closing = host.close();
    try {
      expect(signal?.aborted).toBe(true);
      finish.resolve();
      expect(await pending).toMatchObject({ outcome: "failed", cleanupPending: false });
    } finally {
      finish.resolve();
      finishRecovery.resolve();
      await Promise.all([pending, closing]);
      recovery.mockRestore();
    }
  });

  test("service stop warns and still closes after the first handoff snapshot fails", async () => {
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const finish = Promise.withResolvers<void>();
    devices.prepareHook = async ({ signal }) => {
      entered.resolve(signal);
      await finish.promise;
    };
    const pending = broker.prepare(config("snapshot-failure"), "owner");
    const signal = await entered.promise;
    const failure = new Error("handoff snapshot unavailable");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const release = spyOn(broker, "close");
    let unlocked = false;
    const host = service(() => {
      unlocked = true;
    });
    host.start();
    await drainUntil(() => timer.getPendingTimeouts().includes(5_000), {
      description: "initial recovery finished before handoff snapshot failure",
    });
    const snapshot = spyOn(store, "listRecoverableRequests").mockRejectedValueOnce(failure);
    const closing = Promise.allSettled([host.close()]);
    try {
      expect(signal?.aborted).toBe(true);
      finish.resolve();
      expect(await pending).toMatchObject({ outcome: "failed" });
      expect(await closing).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(unlocked).toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(warning).toHaveBeenCalledWith(
        "Session broker restart handoff failed: handoff snapshot unavailable",
        failure,
      );
    } finally {
      finish.resolve();
      await Promise.all([pending, closing]);
      snapshot.mockRestore();
      warning.mockRestore();
      release.mockRestore();
    }
  });

  test("an inline handoff failure warns without failing the committed grant", async () => {
    const activate = store.activate.bind(store);
    const failure = new Error("handoff write unavailable");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const activation = spyOn(store, "activate").mockImplementationOnce(async (...args) => {
      await broker.markRestartHandoff();
      return activate(...args);
    });
    const handoff = spyOn(store, "relinquishForRestart").mockRejectedValueOnce(failure);
    try {
      expect(await broker.prepare(config("inline-failure"), "owner")).toMatchObject({
        outcome: "ready",
      });
      expect(warning).toHaveBeenCalledWith(
        "Session request inline-failure could not be kept for restart: handoff write unavailable",
        failure,
      );
      expect(devices.released).toEqual([]);
      expect(devices.destroyed).toEqual([]);
      await broker.close();
      expect((await store.getRequest("inline-failure"))?.restartHandoff).toBe(true);
    } finally {
      activation.mockRestore();
      handoff.mockRestore();
      warning.mockRestore();
    }
  });
});
