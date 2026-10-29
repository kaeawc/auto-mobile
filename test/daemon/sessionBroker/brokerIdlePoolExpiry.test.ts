import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { destructionTicket } from "../../../src/daemon/sessionBroker/store";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import {
  androidCatalog,
  androidDefaults,
  iosCatalog,
  iosDefaults,
} from "../../devices/sessionRequirements/fixtures";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";

const TTL_MS = 60_000;

function config(requestId: string, platform: "ios" | "android" = "android"): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform,
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

describe("idle pool expiry", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let timer: FakeTimer;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;

  beforeEach(async () => {
    timer = new FakeTimer();
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
      catalog: async (platform) => (platform === "android" ? androidCatalog() : iosCatalog()),
      defaults: (platform) => (platform === "android" ? androidDefaults() : iosDefaults()),
      reuseCleanDevices: true,
      reuseAndroidCleanDevices: true,
      idleTtlMs: { android: TTL_MS },
      timer,
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  async function pooled(requestId: string, platform?: "ios" | "android"): Promise<string> {
    const result = await broker.prepare(config(requestId, platform), "owner-token");
    expect(await broker.release(result.sessionUuid!)).toMatchObject({ outcome: "released" });
    const resource = (await options.store.listResources()).find(
      (entry) => entry.state === "idle" && !devices.destroyed.includes(entry.resourceId),
    );
    return resource!.resourceId;
  }

  test("destroys an idle Android device only once it has been idle for the TTL", async () => {
    const resourceId = await pooled("first");

    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    timer.advanceTime(TTL_MS - 1);
    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    expect(devices.destroyed).toEqual([]);

    timer.advanceTime(1);
    expect(await broker.expireIdlePool()).toEqual({
      resources: [{ resourceId, outcome: "destroyed", cleanupPending: false }],
    });
    expect(devices.destroyed).toEqual([resourceId]);
    expect(await options.store.getResource(resourceId)).toMatchObject({ state: "destroyed" });
  });

  test("reuse restarts the idle clock", async () => {
    const resourceId = await pooled("first");
    await broker.expireIdlePool();
    timer.advanceTime(TTL_MS - 1);

    expect(await pooled("second")).toBe(resourceId);
    timer.advanceTime(1);
    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    timer.advanceTime(TTL_MS);

    expect((await broker.expireIdlePool()).resources).toEqual([
      expect.objectContaining({ resourceId, outcome: "destroyed" }),
    ]);
  });

  test("never expires a device held by a session", async () => {
    const held = await broker.prepare(config("held"), "owner-token");
    await broker.expireIdlePool();
    timer.advanceTime(TTL_MS * 2);

    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    expect(devices.destroyed).toEqual([]);
    expect(await broker.status("held")).toMatchObject({ outcome: "ready" });
    await broker.release(held.sessionUuid!);
  });

  test("an acquisition that reserves the device between observation and expiry wins", async () => {
    const resourceId = await pooled("first");
    await broker.expireIdlePool();
    timer.advanceTime(TTL_MS);
    const list = options.store.listLiveResources.bind(options.store);
    let acquired: Awaited<ReturnType<SessionBroker["prepare"]>> | undefined;
    options.store.listLiveResources = async () => {
      const snapshot = await list();
      options.store.listLiveResources = list;
      acquired = await broker.prepare(config("racer"), "owner-token");
      return snapshot;
    };

    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    expect(acquired?.outcome).toBe("ready");
    expect(devices.destroyed).toEqual([]);
    expect(await options.store.getResource(resourceId)).toMatchObject({ state: "active" });
  });

  test("the store refuses a stale idle revision", async () => {
    const resourceId = await pooled("first");
    const observed = destructionTicket((await options.store.getResource(resourceId))!);
    await pooled("second");

    expect(await options.store.drainIdle([observed])).toEqual([]);
    expect(await options.store.getResource(resourceId)).toMatchObject({ state: "idle" });
  });

  test("leaves platforms without a TTL in the pool", async () => {
    const iosResource = await pooled("ios", "ios");
    await broker.expireIdlePool();
    timer.advanceTime(TTL_MS * 10);

    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    expect(await options.store.getResource(iosResource)).toMatchObject({ state: "idle" });
  });

  test("reports cleanup_pending when native destruction is not yet absent", async () => {
    const resourceId = await pooled("first");
    await broker.expireIdlePool();
    timer.advanceTime(TTL_MS);
    devices.canDestroy = false;

    expect(await broker.expireIdlePool()).toEqual({
      resources: [{ resourceId, outcome: "cleanup_pending", cleanupPending: true }],
    });
    expect(await options.store.getResource(resourceId)).toMatchObject({ state: "destroying" });
  });

  test("a stopping broker expires nothing", async () => {
    const resourceId = await pooled("first");
    await broker.expireIdlePool();
    timer.advanceTime(TTL_MS);
    await broker.markRestartHandoff();

    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    expect(await options.store.getResource(resourceId)).toMatchObject({ state: "idle" });
  });

  test("a new broker over the same store restarts the idle clock", async () => {
    const resourceId = await pooled("first");
    await broker.expireIdlePool();
    timer.advanceTime(TTL_MS);
    await broker.close();
    broker = new SessionBroker(options);

    expect(await broker.expireIdlePool()).toEqual({ resources: [] });
    timer.advanceTime(TTL_MS);
    expect((await broker.expireIdlePool()).resources).toEqual([
      expect.objectContaining({ resourceId, outcome: "destroyed" }),
    ]);
  });
});
