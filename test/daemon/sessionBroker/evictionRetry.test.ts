import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import { SessionBrokerInvariantError } from "../../../src/daemon/sessionBroker/SessionBrokerInvariantError";
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

  beforeAll(async () => {
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    const timer = new FakeTimer();
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
        failure: { code: "eviction_pending", retryable: true, retryAfterMs: 1_000 },
      });
      expect(failed.failure).toHaveProperty("retryRequires", "new_request_id");
      expect(await options.store.getRequest(request.requestId)).toMatchObject({
        errorCode: "eviction_pending",
        retryable: true,
      });
      expect((await options.store.listResources())[0].state).toBe("destroying");
      expect(devices.prepared).toHaveLength(1);
      expect(await broker.ownedStatus(request.requestId, "owner-token")).toEqual(failed);
      expect(await broker.prepare(request, "owner-token")).toEqual(failed);
      devices.destroyError = undefined;
      devices.canDestroy = true;
      await broker.recover();
      expect((await options.store.listResources())[0].state).toBe("destroyed");
      // Reconstruct the broker to prove the failure remains durable after recovery.
      broker = new SessionBroker(options);
      const recoveredFailure = { ...failed, cleanupPending: false };
      expect(await broker.ownedStatus(request.requestId, "owner-token")).toEqual(recoveredFailure);
      expect(await broker.prepare(request, "owner-token")).toEqual(recoveredFailure);
      const retry = config("needs-tablet-retry", true);
      const ready = await broker.prepare(retry, "owner-token");
      expect(ready).toMatchObject({ outcome: "ready", requestId: retry.requestId });
      expect(devices.prepared).toHaveLength(2);
      expect(await broker.prepare(retry, "owner-token")).toEqual(ready);
    },
  );

  test.each([
    ["unknown", new Error("permission denied")],
    ["permanent", new SessionBrokerInvariantError("eviction ownership lost")],
  ] as const)(
    "%s eviction failure stays terminal and generic after capacity frees",
    async (kind, error) => {
      devices.destroyError = error;
      const request = config(kind, true);
      const failed = await broker.prepare(request, "owner-token");
      expect(failed).toMatchObject({
        outcome: "failed",
        failure: { code: "session_preparation_failed", message: error.message, retryable: false },
      });
      expect(failed.failure).not.toHaveProperty("retryAfterMs");
      expect(await options.store.getRequest(request.requestId)).toMatchObject({ retryable: false });
      devices.destroyError = undefined;
      await broker.recover();
      expect(await broker.prepare(request, "owner-token")).toMatchObject({
        outcome: "failed",
        failure: { code: "session_preparation_failed", retryable: false },
      });
      expect(devices.prepared).toHaveLength(1);
    },
  );
});
