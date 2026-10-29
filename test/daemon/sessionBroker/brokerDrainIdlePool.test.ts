import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

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

interface BrokerFixture {
  registry: SqliteBindingRegistry;
  devices: FakeNativePort;
  options: SessionBrokerOptions;
  broker: SessionBroker;
}

async function openBrokerFixture(): Promise<BrokerFixture> {
  const timer = new FakeTimer();
  const registry = await openSqliteBindingRegistry({
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
  const devices = new FakeNativePort(registry);
  const options: SessionBrokerOptions = {
    store: registry.sessionBrokerStore(scope.scope.scopeKey, new CountingIdGenerator("resource")),
    devices,
    owner: FAKE_BROKER_OWNER,
    limits: { totalDeviceCap: 3, sessionCap: 3, idlePoolCap: 3 },
    catalog: async () => iosCatalog(),
    defaults: () => iosDefaults(),
    reuseCleanDevices: true,
    timer,
  };
  return { registry, devices, options, broker: new SessionBroker(options) };
}

describe("drainIdlePool", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;

  // The first prepare/release/drain in a process pays one-time module and SQLite warm-up
  // (~40 ms); run one cycle on a throwaway broker so no test's budget carries it.
  beforeAll(async () => {
    const warm = await openBrokerFixture();
    const prepared = await warm.broker.prepare(config("warm-up"), "owner-token");
    await warm.broker.release(prepared.sessionUuid!);
    await warm.broker.drainIdlePool();
    await warm.broker.close();
    await warm.registry.close();
  });

  beforeEach(async () => {
    ({ registry, devices, options, broker } = await openBrokerFixture());
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

  test.each(["first", "second"] as const)(
    "close waits for the entire drain when called during the %s destruction",
    async (closeDuring) => {
      const first = await broker.prepare(config("first"), "owner-token");
      const second = await broker.prepare(config("second"), "owner-token");
      await broker.release(first.sessionUuid!);
      await broker.release(second.sessionUuid!);
      const idle = (await options.store.listResources()).map((resource) => resource.resourceId);
      expect(idle).toHaveLength(2);

      const firstEntered = Promise.withResolvers<void>();
      const finishFirst = Promise.withResolvers<void>();
      const secondEntered = Promise.withResolvers<void>();
      const finishSecond = Promise.withResolvers<void>();
      const destroy = devices.destroy.bind(devices);
      let calls = 0;
      devices.destroy = async (resource) => {
        calls++;
        if (calls === 1) {
          firstEntered.resolve();
          await finishFirst.promise;
        } else {
          secondEntered.resolve();
          await finishSecond.promise;
        }
        return destroy(resource);
      };
      const completed: string[] = [];
      const draining = broker.drainIdlePool().then((result) => {
        completed.push("drain");
        return result;
      });
      let closing: Promise<void> | undefined;
      const close = () =>
        broker.close().then(() => {
          completed.push("close");
        });
      try {
        await firstEntered.promise;
        if (closeDuring === "first") {
          closing = close();
          await drainMicrotasks(1_000);
          expect(completed).toEqual([]);
        }
        finishFirst.resolve();
        await secondEntered.promise;
        expect(devices.destroyed).toHaveLength(1);
        if (closeDuring === "second") {
          closing = close();
        }
        await drainMicrotasks(1_000);
        expect(completed).toEqual([]);
      } finally {
        finishFirst.resolve();
        finishSecond.resolve();
        await draining;
        await closing;
      }
      expect(completed).toEqual(["drain", "close"]);
      expect([...devices.destroyed].sort()).toEqual([...idle].sort());
      for (const resourceId of idle) {
        expect(await options.store.getResource(resourceId)).toMatchObject({ state: "destroyed" });
      }
    },
  );

  test("reports destroyed after the released receipt and destruction tombstone are pruned", async () => {
    await readyAndReleased("expired");
    const [idle] = await options.store.listResources();
    expect(await options.store.pruneTerminalRequests(0, 10)).toBe(1);
    expect(await options.store.getRequest("expired")).toBeUndefined();
    expect(await options.store.getResource(idle.resourceId)).toMatchObject({
      state: "idle",
      requestId: null,
    });

    const drained = await broker.drainIdlePool();

    expect(drained.resources).toEqual([
      { resourceId: idle.resourceId, outcome: "destroyed", cleanupPending: false },
    ]);
    expect(devices.destroyed).toEqual([idle.resourceId]);
    expect(await options.store.getResource(idle.resourceId)).toBeUndefined();
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
