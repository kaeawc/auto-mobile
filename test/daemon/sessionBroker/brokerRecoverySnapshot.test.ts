import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, mock } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";

afterEach(() => {
  mock.restore();
});

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

// A recovery pass decides from one listRequests snapshot, then awaits each request in turn.
// A preparation that commits while the pass is still walking must not be failed from that
// stale "acquiring" view: the consumer already holds a ready session.
describe("broker recovery acts on current request state, not its snapshot", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;

  beforeAll(async () => {
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    registry = await openSqliteBindingRegistry({ dbPath: ":memory:", isExecOwnerLive: () => true });
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
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 0 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  test("a preparation that commits mid-pass keeps its ready session", async () => {
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    devices.prepareHook = async () => {
      entered.resolve();
      await complete.promise;
    };
    const pending = broker.prepare(config("mid-pass"), "owner-token");
    await entered.promise;

    const list = options.store.listRecoverableRequests.bind(options.store);
    spyOn(options.store, "listRecoverableRequests").mockImplementationOnce(async () => {
      const snapshot = await list();
      // The preparation finishes while this pass is still walking earlier requests.
      complete.resolve();
      expect(await pending).toMatchObject({ outcome: "ready" });
      return snapshot;
    });
    await broker.recover();

    const ready = await pending;
    expect(await broker.status("mid-pass")).toMatchObject({
      outcome: "ready",
      sessionUuid: ready.sessionUuid,
    });
    expect(devices.destroyed).toEqual([]);
    expect(await broker.hasActiveSession(ready.sessionUuid!)).toBe(true);
  });
});
