import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BrokerResourceRecord } from "../../../src/daemon/sessionBroker/store";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { ActionableError } from "../../../src/models/ActionableError";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";

class EvictionPort extends FakeNativePort {
  destroyError?: Error;

  override async destroy(resource: BrokerResourceRecord): Promise<"absent" | "pending"> {
    if (this.destroyError) {
      throw this.destroyError;
    }
    return super.destroy(resource);
  }
}

function config(requestId: string, tablet = false): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "ios",
      hardware: tablet ? { kind: "archetype", archetype: "tablet" } : { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

describe("idle eviction retry receipts", () => {
  let registry: SqliteBindingRegistry;
  let devices: EvictionPort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;
  let timer: FakeTimer;

  beforeAll(async () => {
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: () => true,
    });
    const scope = await registry.ensureScope({
      managedHostScope: "eviction-host",
      runnerNamespace: "eviction-broker",
      runnerIncarnation: "persistent",
    });
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    devices = new EvictionPort(registry);
    options = {
      store: registry.sessionBrokerStore(scope.scope.scopeKey, new CountingIdGenerator("resource")),
      devices,
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 1 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
      reuseCleanDevices: true,
      sessionDisposition: () => "live",
    };
    broker = new SessionBroker(options);
    const warm = await broker.prepare(config("warm"), "owner-token");
    expect(warm.outcome).toBe("ready");
    expect(warm.sessionUuid).not.toBeNull();
    await broker.release(warm.sessionUuid!);
    expect((await options.store.listResources())[0].state).toBe("idle");
  });

  afterEach(async () => {
    devices.destroyError = undefined;
    devices.canDestroy = true;
    await broker.close();
    await registry.close();
  });

  test.each(["pending", "timeout", "wrapped-timeout"] as const)(
    "%s eviction stores a retryable failure and a new request succeeds after recovery",
    async (kind) => {
      devices.canDestroy = kind !== "pending";
      if (kind !== "pending") {
        const timeout = new SimctlCommandTimeoutError("delete exceeded its budget");
        devices.destroyError =
          kind === "timeout" ? timeout : new ActionableError("delete failed", { cause: timeout });
      }
      const request = config("needs-tablet", true);
      const failed = await broker.prepare(request, "owner-token");
      expect(failed).toMatchObject({
        outcome: "failed",
        failure: { code: "cleanup_pending", retryable: true, retryAfterMs: 1_000 },
      });
      expect(failed.failure).not.toHaveProperty("retryRequires");
      expect(await options.store.getRequest(request.requestId)).toMatchObject({
        errorCode: "cleanup_pending",
        retryable: true,
      });
      expect((await options.store.listResources())[0].state).toBe("destroying");
      expect(devices.prepared).toHaveLength(1);
      expect(await broker.ownedStatus(request.requestId, "owner-token")).toEqual(failed);
      devices.destroyError = undefined;
      devices.canDestroy = true;
      timer.advanceTime(1_000);
      await broker.recover();
      expect((await options.store.listResources())[0].state).toBe("destroyed");
      // Reconstruct the broker to prove the failure remains durable after recovery.
      broker = new SessionBroker(options);
      expect(await broker.ownedStatus(request.requestId, "owner-token")).toMatchObject({
        outcome: "failed",
        failure: { code: "cleanup_pending", retryable: true, retryAfterMs: 1_000 },
      });
      const retry = config("needs-tablet-retry", true);
      const ready = await broker.prepare(retry, "owner-token");
      expect(ready).toMatchObject({ outcome: "ready", requestId: retry.requestId });
      expect(devices.prepared).toHaveLength(2);
      expect(await broker.prepare(retry, "owner-token")).toEqual(ready);
    },
  );

  test("permanent eviction failure stays terminal and generic after capacity frees", async () => {
    devices.destroyError = new Error("permission denied");
    const request = config("permanent", true);
    const failed = await broker.prepare(request, "owner-token");
    expect(failed).toMatchObject({
      outcome: "failed",
      failure: { code: "session_preparation_failed", retryable: false },
    });
    expect(await options.store.getRequest(request.requestId)).toMatchObject({ retryable: false });
    devices.destroyError = undefined;
    await broker.recover();
    expect(await broker.prepare(request, "owner-token")).toMatchObject({
      outcome: "failed",
      failure: { code: "session_preparation_failed", retryable: false },
    });
    expect(devices.prepared).toHaveLength(1);
  });
});
