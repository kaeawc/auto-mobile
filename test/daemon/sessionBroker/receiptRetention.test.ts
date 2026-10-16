import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  RECEIPT_RETENTION_MS,
  SessionBroker,
  type SessionBrokerOptions,
} from "../../../src/daemon/sessionBroker/broker";
import {
  RECEIPT_PRUNE_INTERVAL_MS,
  SessionBrokerService,
} from "../../../src/daemon/sessionBroker/service";
import type { BindingProcessIdentity } from "../../../src/daemon/sessionBroker/registry/bindingRegistry";
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

const SUCCESSOR: BindingProcessIdentity = { ...FAKE_BROKER_OWNER, pid: 202, daemonId: "successor" };

describe("terminal receipt recovery cost and retention", () => {
  let timer: FakeTimer;
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;
  let ownerLive = true;

  beforeAll(async () => {
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    ownerLive = true;
    timer = new FakeTimer();
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
    options = {
      store: registry.sessionBrokerStore(scope.scope.scopeKey, new CountingIdGenerator("resource")),
      devices,
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  async function releasedReceipt(requestId: string) {
    const ready = await broker.prepare(config(requestId), "owner-token");
    expect(ready.outcome).toBe("ready");
    await broker.release(ready.sessionUuid!);
    return broker.prepare(config(requestId), "owner-token");
  }

  async function terminalReceipts() {
    await releasedReceipt("released");
    await broker.abandon("abandoned-unseen", "owner-token");
    options.catalog = () => Promise.reject(new Error("catalog unavailable"));
    await broker.prepare(config("pre-admission"), "owner-token");
  }

  test("a successor's recovery pass opens no write transaction for settled terminal receipts", async () => {
    await terminalReceipts();
    ownerLive = false;
    const successor = new SessionBroker({ ...options, owner: SUCCESSOR });
    const recoverRequest = spyOn(options.store, "recoverRequest");
    const fail = spyOn(options.store, "fail");
    const failInterrupted = spyOn(options.store, "failInterruptedAcquisition");
    const beginRelease = spyOn(options.store, "beginRelease");
    await successor.recover();
    expect(recoverRequest).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(failInterrupted).not.toHaveBeenCalled();
    expect(beginRelease).not.toHaveBeenCalled();
    expect(await options.store.listRecoverableRequests()).toEqual([]);
  });

  test("the owner's own recovery pass takes no per-request store transaction for its live receipt", async () => {
    options.sessionDisposition = () => "live";
    broker = new SessionBroker(options);
    await broker.prepare(config("live"), "owner-token");
    const recoverRequest = spyOn(options.store, "recoverRequest");
    await broker.recover();
    expect(recoverRequest).not.toHaveBeenCalled();
    expect(await broker.status("live")).toMatchObject({ outcome: "ready" });
  });

  test("a dead owner's live receipt is still taken over by a successor", async () => {
    await broker.prepare(config("orphan"), "owner-token");
    ownerLive = false;
    const successor = new SessionBroker({ ...options, owner: SUCCESSOR });
    await successor.recover();
    expect(await options.store.getRequest("orphan")).toMatchObject({
      state: "failed",
      errorCode: "session_owner_exited",
    });
  });

  test("replay inside the retention window is unchanged; past it the identity is forgotten", async () => {
    const replay = await releasedReceipt("released");
    expect(replay.outcome).toBe("released");
    expect(await options.store.listResources()).toHaveLength(1);

    timer.advanceTime(RECEIPT_RETENTION_MS - 1);
    expect(await broker.pruneReceipts()).toBe(0);
    expect(await broker.prepare(config("released"), "owner-token")).toEqual(replay);
    expect(await broker.ownedStatus("released", "owner-token")).toEqual(replay);

    timer.advanceTime(1);
    expect(await broker.pruneReceipts()).toBe(1);
    expect(await broker.status("released")).toBeUndefined();
    expect(await options.store.listResources()).toEqual([]);
  });

  test("a terminal receipt whose device cleanup is still pending is never pruned", async () => {
    devices.prepareError = new Error("native failure");
    devices.canDestroy = false;
    const failed = await broker.prepare(config("dirty"), "owner-token");
    expect(failed).toMatchObject({ outcome: "failed", cleanupPending: true });
    timer.advanceTime(RECEIPT_RETENTION_MS * 2);
    expect(await broker.pruneReceipts()).toBe(0);
    expect(await broker.status("dirty")).toEqual(failed);
    devices.canDestroy = true;
    await broker.recover();
    const cleaned = await broker.status("dirty");
    expect(cleaned).toMatchObject({ outcome: "failed", cleanupPending: false });
    // Confirmed cleanup changed the answer, so the replay window restarts from it.
    timer.advanceTime(RECEIPT_RETENTION_MS - 1);
    expect(await broker.pruneReceipts()).toBe(0);
    expect(await broker.prepare(config("dirty"), "owner-token")).toEqual(cleaned);
    timer.advanceTime(1);
    expect(await broker.pruneReceipts()).toBe(1);
  });

  test("the service prunes at most once per interval", async () => {
    const lock = { acquire: () => undefined, release: () => undefined };
    const prune = spyOn(broker, "pruneReceipts");
    const recover = spyOn(broker, "recover").mockResolvedValue(undefined);
    const service = new SessionBrokerService(broker, "scope", lock, timer);
    service.start();
    for (let pass = 0; pass < 3; pass++) {
      await timer.advanceTimeAsync(5_000);
    }
    expect(recover.mock.calls.length).toBe(3);
    expect(prune).toHaveBeenCalledTimes(1);
    await timer.advanceTimeAsync(RECEIPT_PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    await service.close();
  });
});
