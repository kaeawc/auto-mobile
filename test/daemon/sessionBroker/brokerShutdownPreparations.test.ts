import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import { SessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { logger } from "../../../src/utils/logger";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
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
    broker = new SessionBroker({
      store,
      devices,
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 0 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
      sessionDisposition: () => "live",
    });
  });

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
      const recovery = spyOn(broker, "recover").mockImplementationOnce(async () => {
        recoveryEntered.resolve();
        await finishRecovery.promise;
        recoverySettled = true;
      });
      const host = service();
      if (entry === "service") {
        host.start();
        timer.advanceTime(5_000);
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
    const recovery = spyOn(broker, "recover").mockImplementationOnce(async () => {
      recoveryEntered.resolve();
      await finishRecovery.promise;
    });
    const host = service();
    host.start();
    timer.advanceTime(5_000);
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
    const snapshot = spyOn(store, "listRecoverableRequests").mockRejectedValueOnce(failure);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const release = spyOn(broker, "close");
    let unlocked = false;
    const host = service(() => {
      unlocked = true;
    });
    host.start();
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
