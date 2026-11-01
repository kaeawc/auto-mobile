import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import { SessionBrokerMaintenanceError } from "../../../src/daemon/sessionBroker/SessionBrokerMaintenanceError";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { androidCatalog, androidDefaults } from "../../devices/sessionRequirements/fixtures";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

function config(requestId: string): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "android",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

describe("broker AVD snapshot cleanup fence", () => {
  let registry: SqliteBindingRegistry;
  let broker: SessionBroker;
  let devices: FakeNativePort;
  let store: ReturnType<SqliteBindingRegistry["sessionBrokerStore"]>;
  beforeEach(async () => {
    const timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: () => true,
    });
    const scope = await registry.ensureScope({
      managedHostScope: "cleanup-host",
      runnerNamespace: "cleanup-broker",
      runnerIncarnation: "persistent",
    });
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    store = registry.sessionBrokerStore(scope.scope.scopeKey);
    devices = new FakeNativePort(registry);
    broker = new SessionBroker({
      store,
      devices,
      timer,
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 3, sessionCap: 3, idlePoolCap: 0 },
      catalog: async () => androidCatalog(),
      defaults: () => androidDefaults(),
    });
  });
  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  test("close joins an in-flight snapshot cleanup operation", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const cleanup = broker.cleanupAvdSnapshots(async () => {
      entered.resolve();
      await finish.promise;
      return [];
    });
    await entered.promise;
    let closed = false;
    const closing = broker.close().then(() => {
      closed = true;
    });
    try {
      await drainMicrotasks(100);
      expect(closed).toBe(false);
    } finally {
      finish.resolve();
      await cleanup;
      await closing;
    }
    expect(closed).toBe(true);
  });

  test("prepare refuses synchronously during cleanup without writing a receipt, then accepts the same identity", async () => {
    const finish = Promise.withResolvers<void>();
    const cleanup = broker.cleanupAvdSnapshots(async () => {
      await finish.promise;
      return [];
    });
    try {
      const refusal = broker.prepare(config("retry-me"), "owner");
      await expect(refusal).rejects.toBeInstanceOf(SessionBrokerMaintenanceError);
      await expect(refusal).rejects.toMatchObject({
        retryable: true,
        code: "session_broker_maintenance",
      });
      expect(await store.getRequest("retry-me")).toBeUndefined();
      await expect(broker.cleanupAvdSnapshots(async () => [])).rejects.toBeInstanceOf(
        SessionBrokerMaintenanceError,
      );
    } finally {
      finish.resolve();
      await cleanup;
    }
    expect(await broker.prepare(config("retry-me"), "owner")).toMatchObject({ outcome: "ready" });
  });

  test("cleanup failure releases the marker", async () => {
    await expect(
      broker.cleanupAvdSnapshots(async () => {
        throw new Error("cleanup failed");
      }),
    ).rejects.toThrow("cleanup failed");
    expect(await broker.prepare(config("after-failure"), "owner")).toMatchObject({
      outcome: "ready",
    });
  });

  test.each([false, true])(
    "in-flight preparation settles before deletion, including failure=%s",
    async (fails) => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      devices.prepareHook = async () => {
        entered.resolve();
        await finish.promise;
      };
      if (fails) {
        devices.prepareError = new Error("preparation failed");
      }
      const preparation = broker.prepare(config("in-flight"), "owner");
      await entered.promise;
      let deleting = false;
      const cleanup = broker.cleanupAvdSnapshots(async () => {
        deleting = true;
        expect((await store.getRequest("in-flight"))?.state).toBe(fails ? "failed" : "active");
        return [];
      });
      try {
        await drainMicrotasks(20);
        expect(deleting).toBe(false);
        await expect(broker.prepare(config("during-wait"), "owner")).rejects.toBeInstanceOf(
          SessionBrokerMaintenanceError,
        );
      } finally {
        finish.resolve();
        await preparation;
        await cleanup;
      }
      expect(deleting).toBe(true);
    },
  );
});
