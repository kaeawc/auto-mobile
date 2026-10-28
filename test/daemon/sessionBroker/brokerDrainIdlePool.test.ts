import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
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

describe("drainIdlePool", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;

  beforeEach(async () => {
    const timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: () => true,
      timer,
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
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 3, sessionCap: 3, idlePoolCap: 3 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
      reuseCleanDevices: true,
      timer,
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  async function readyAndReleased(requestId: string): Promise<string> {
    const result = await broker.prepare(config(requestId), "owner-token");
    if (!result.sessionUuid) {
      throw new Error("Missing session UUID");
    }
    expect(await broker.release(result.sessionUuid)).toMatchObject({ outcome: "released" });
    return result.sessionUuid;
  }

  test("destroys every idle pooled device with a terminal per-device outcome", async () => {
    // Both sessions are held at once so two distinct devices enter the pool.
    const first = await broker.prepare(config("first"), "owner-token");
    const second = await broker.prepare(config("second"), "owner-token");
    expect(await broker.release(first.sessionUuid!)).toMatchObject({ outcome: "released" });
    expect(await broker.release(second.sessionUuid!)).toMatchObject({ outcome: "released" });
    const idle = (await options.store.listResources()).map((resource) => resource.resourceId);
    expect(idle).toHaveLength(2);

    const drained = await broker.drainIdlePool();

    expect(drained.resources.map((entry) => entry.resourceId).sort()).toEqual([...idle].sort());
    expect(drained.resources.every((entry) => entry.outcome === "destroyed")).toBe(true);
    expect(drained.resources.every((entry) => entry.cleanupPending === false)).toBe(true);
    expect([...devices.destroyed].sort()).toEqual([...idle].sort());
    for (const resource of await options.store.listResources()) {
      expect(resource.state).toBe("destroyed");
    }
  });

  test("replaying the drain after it settled is a no-op", async () => {
    await readyAndReleased("first");
    await broker.drainIdlePool();

    const replay = await broker.drainIdlePool();

    expect(replay.resources).toEqual([]);
    expect(devices.destroyed).toHaveLength(1);
  });

  test("leaves an active session's device untouched", async () => {
    const active = await broker.prepare(config("active"), "owner-token");
    expect(active.outcome).toBe("ready");
    await readyAndReleased("pooled");
    const activeResource = (await options.store.listResources()).find(
      (resource) => resource.state === "active" || resource.state === "reserved",
    );

    const drained = await broker.drainIdlePool();

    expect(drained.resources).toHaveLength(1);
    expect(drained.resources[0].resourceId).not.toBe(activeResource?.resourceId);
    expect(devices.destroyed).not.toContain(activeResource?.resourceId);
    expect(await broker.status("active")).toMatchObject({ outcome: "ready" });
  });

  test("reports cleanup_pending when native destruction is not yet absent", async () => {
    await readyAndReleased("first");
    devices.canDestroy = false;

    const drained = await broker.drainIdlePool();

    expect(drained.resources).toEqual([
      expect.objectContaining({ outcome: "cleanup_pending", cleanupPending: true }),
    ]);
    expect(devices.destroyed).toEqual([]);
    const [resource] = await options.store.listResources();
    expect(resource.state).toBe("destroying");
  });
});
