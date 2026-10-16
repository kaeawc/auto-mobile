import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import type { SessionLiveness } from "../../../src/daemon/sessionBroker/sessionDisposition";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
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

// Owner decision: once activation has committed, a caller's abort (its connection went away)
// hands the session back instead of destroying it. A reconnecting client replays its request
// identity and gets the ready session; one that never returns is cleaned up when its session's
// liveness lapses. An abort before activation keeps the existing cleanup.
describe("caller abort around session activation", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;
  let disposition: SessionLiveness;

  beforeAll(async () => {
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    disposition = "live";
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
      sessionDisposition: () => disposition,
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  function abortRightAfterActivation(controller: AbortController) {
    const activate = options.store.activate.bind(options.store);
    spyOn(options.store, "activate").mockImplementationOnce(async (...args) => {
      const request = await activate(...args);
      controller.abort(new Error("client connection closed"));
      return request;
    });
  }

  test("an abort after activation commits keeps the session for a replaying client", async () => {
    const controller = new AbortController();
    abortRightAfterActivation(controller);
    const first = await broker.prepare(config("reconnect"), "owner-token", controller.signal);
    expect(first).toMatchObject({ outcome: "ready" });
    expect(devices.destroyed).toEqual([]);
    expect(devices.released).toEqual([]);

    const replay = await broker.prepare(config("reconnect"), "owner-token");
    expect(replay).toEqual(first);
    expect(await broker.hasActiveSession(first.sessionUuid!)).toBe(true);
    expect(devices.prepared).toHaveLength(1);
  });

  test("a handed-back session the client never reclaims is released once its liveness lapses", async () => {
    const controller = new AbortController();
    abortRightAfterActivation(controller);
    const first = await broker.prepare(config("never-returns"), "owner-token", controller.signal);
    await broker.recover();
    expect(await broker.status("never-returns")).toMatchObject({ outcome: "ready" });

    // The acquisition put the session on the managed-execution idle policy; with no heartbeat it
    // is released, and the session's disposition reads gone.
    disposition = "gone";
    await broker.recover();
    expect(devices.released).toEqual([first.sessionUuid!]);
    expect(devices.destroyed).toHaveLength(1);
    expect(await broker.status("never-returns")).toMatchObject({
      outcome: "released",
      sessionUuid: first.sessionUuid,
      cleanupPending: false,
    });
  });

  test("an abort before activation still fails the request and destroys its device", async () => {
    const controller = new AbortController();
    devices.prepareHook = async () => {
      controller.abort(new Error("client connection closed"));
    };
    const failed = await broker.prepare(config("early-abort"), "owner-token", controller.signal);
    expect(failed).toMatchObject({ outcome: "failed", sessionUuid: null, cleanupPending: false });
    expect(devices.destroyed).toHaveLength(1);
    expect(devices.sessions.size).toBe(0);
  });
});
