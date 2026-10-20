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

// #12771: once activation commits, the grant belongs to the request identity. A failure reading or
// assembling the receipt afterwards is uncertainty about the reply, not a preparation failure, so
// it must never fail the active request or release/destroy its device.
describe("receipt read failure after session activation", () => {
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
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
      sessionDisposition: () => "live",
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  test("an aborted caller whose receipt reread fails keeps the grant for a replay", async () => {
    const controller = new AbortController();
    const getRequest = spyOn(options.store, "getRequest");
    const activate = options.store.activate.bind(options.store);
    const afterCommit = () => {
      controller.abort(new Error("client connection closed"));
      getRequest.mockRejectedValueOnce(new Error("database is locked"));
    };
    spyOn(options.store, "activate").mockImplementationOnce(async (...args) => {
      const request = await activate(...args);
      expect(request.state).toBe("active");
      await afterCommit();
      return request;
    });

    await expect(
      broker.prepare(config("reread-fails"), "owner-token", controller.signal),
    ).rejects.toThrow(/committed/);
    expect(devices.released).toEqual([]);
    expect(devices.destroyed).toEqual([]);

    const replay = await broker.prepare(config("reread-fails"), "owner-token");
    expect(replay).toMatchObject({ outcome: "ready", cleanupPending: false });
    expect(replay.failure).toBeUndefined();
    expect(await broker.hasActiveSession(replay.sessionUuid!)).toBe(true);
    expect(devices.prepared).toHaveLength(1);
  });

  test("a failed result assembly after activation keeps the grant for a replay", async () => {
    const listResources = spyOn(options.store, "listResources");
    const activate = options.store.activate.bind(options.store);
    const afterCommit = () => listResources.mockRejectedValueOnce(new Error("database is locked"));
    spyOn(options.store, "activate").mockImplementationOnce(async (...args) => {
      const request = await activate(...args);
      expect(request.state).toBe("active");
      await afterCommit();
      return request;
    });

    await expect(broker.prepare(config("assembly-fails"), "owner-token")).rejects.toThrow(
      /committed/,
    );
    expect(devices.released).toEqual([]);
    expect(devices.destroyed).toEqual([]);
    expect(await broker.status("assembly-fails")).toMatchObject({ outcome: "ready" });

    const replay = await broker.prepare(config("assembly-fails"), "owner-token");
    expect(replay).toMatchObject({ outcome: "ready" });
    expect(await broker.hasActiveSession(replay.sessionUuid!)).toBe(true);
  });

  test("a durable abandonment after activation wins over stale ready evidence", async () => {
    const controller = new AbortController();
    const activate = options.store.activate.bind(options.store);
    const afterCommit = async () => {
      await options.store.abandon("abandoned", FAKE_BROKER_OWNER, "owner-token");
      controller.abort(new Error("client connection closed"));
    };
    spyOn(options.store, "activate").mockImplementationOnce(async (...args) => {
      const request = await activate(...args);
      expect(request.state).toBe("active");
      await afterCommit();
      return request;
    });

    const result = await broker.prepare(config("abandoned"), "owner-token", controller.signal);
    expect(result.outcome).not.toBe("ready");
    expect(await broker.hasActiveSession(result.sessionUuid ?? "none")).toBe(false);
  });

  test("a store failure before activation still fails the request and cleans up", async () => {
    spyOn(options.store, "activate").mockRejectedValueOnce(new Error("database is locked"));

    const failed = await broker.prepare(config("pre-activation"), "owner-token");
    expect(failed).toMatchObject({ outcome: "failed", sessionUuid: null });
    expect(devices.destroyed).toHaveLength(1);
  });
});
