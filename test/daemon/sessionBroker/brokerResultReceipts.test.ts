import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, mock } from "bun:test";
import { SessionBrokerFailureError } from "../../../src/daemon/sessionBroker/devicePort";
import { SessionBrokerStoppingError } from "../../../src/daemon/sessionBroker/SessionBrokerStoppingError";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { SESSION_REQUEST_ABANDONED_CODE } from "../../../src/daemon/sessionBroker/requestIdentity";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import {
  androidCatalog,
  androidDefaults,
  iosCatalog,
  iosDefaults,
} from "../../devices/sessionRequirements/fixtures";
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

// Receipt-shaping races found in review after the broker landed (#12762, #12766).
describe("broker result receipts", () => {
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

  test("Android receipt replays configured memory beside effective launch hardware", async () => {
    options.catalog = async () => androidCatalog();
    options.defaults = () =>
      androidDefaults({
        hardware: {
          omitted: "phone",
          profiles: [{ archetype: "phone", profileId: "pixel_phone", memoryMb: 2048 }],
        },
      });
    const prepare = devices.prepare.bind(devices);
    devices.prepare = async (...args) => {
      const prepared = await prepare(...args);
      return {
        ...prepared,
        profile: { ...prepared.profile, effectiveRamMb: 2560, effectiveCpuCores: 4 },
      };
    };
    const request = {
      ...config("android-hardware"),
      device: {
        schemaVersion: 1 as const,
        platform: "android" as const,
        hardware: { kind: "omitted" as const },
        os: { kind: "omitted" as const },
      },
    };
    const first = await broker.prepare(request, "owner-token");
    expect(first).toMatchObject({
      outcome: "ready",
      profile: {
        platform: "android",
        memoryMb: 2048,
        effectiveRamMb: 2560,
        effectiveCpuCores: 4,
      },
    });
    expect(await broker.prepare(request, "owner-token")).toEqual(first);
  });

  test("a retryable post-admission capacity failure carries the retry hint on the first reply", async () => {
    devices.prepareError = new SessionBrokerFailureError({
      code: "capacity_exhausted",
      message: "No device capacity",
      retryable: true,
    });
    const first = await broker.prepare(config("late-capacity"), "owner-token");
    expect(first).toMatchObject({
      outcome: "failed",
      failure: { code: "capacity_exhausted", retryable: true, retryRequires: "new_request_id" },
    });
    expect(await broker.prepare(config("late-capacity"), "owner-token")).toEqual(first);
  });

  test.each([
    ["client", "pre-admission"],
    ["client", "post-admission"],
    ["shutdown", "pre-admission"],
    ["shutdown", "post-admission"],
  ] as const)(
    "%s cancellation %s preserves its admission and replay contract",
    async (source, phase) => {
      const controller = new AbortController();
      const cancel = async (signal?: AbortSignal) => {
        if (source === "client") {
          controller.abort(new Error("Client RPC cancelled"));
        } else {
          await broker.markRestartHandoff();
        }
        signal?.throwIfAborted();
      };
      if (phase === "pre-admission") {
        options.catalog = async (_platform, signal) => {
          await cancel(signal);
          return iosCatalog();
        };
      } else {
        devices.prepareHook = async ({ signal }) => cancel(signal);
      }

      const request = config("cancelled-request");
      const preparing = broker.prepare(request, "owner-token", controller.signal);
      if (source === "shutdown" && phase === "pre-admission") {
        await expect(preparing).rejects.toBeInstanceOf(SessionBrokerStoppingError);
        expect(await options.store.getRequest(request.requestId)).toBeUndefined();
        await broker.close();
        options.catalog = async () => iosCatalog();
        broker = new SessionBroker(options);
        expect(await broker.prepare(request, "owner-token")).toMatchObject({ outcome: "ready" });
        expect(devices.prepared).toHaveLength(1);
        return;
      }
      const first = await preparing;
      if (source === "shutdown") {
        await broker.close();
        broker = new SessionBroker(options);
      }
      const replay = await broker.prepare(request, "owner-token");
      const expected = {
        outcome: "failed",
        cleanupPending: false,
        failure: {
          code: source === "shutdown" ? "session_broker_stopping" : "cancelled",
          retryable: true,
          retryRequires: "new_request_id",
          ...(source === "shutdown" ? { retryAfterMs: 5_000 } : {}),
        },
      };
      expect(first).toMatchObject(expected);
      expect(replay).toMatchObject(expected);
      expect(replay).toEqual(first);
      expect(devices.prepared).toHaveLength(phase === "pre-admission" ? 0 : 1);
    },
  );

  test.each([true, false])(
    "managed cleanup_pending replays without an eviction delay with confirmed cleanup=%s",
    async (cleanupConfirmed) => {
      devices.prepareError = new SessionBrokerFailureError({
        code: "cleanup_pending",
        message: "Managed device deletion is pending",
        retryable: true,
      });
      devices.canDestroy = cleanupConfirmed;
      const request = config("managed-cleanup");
      const first = await broker.prepare(request, "owner-token");
      expect(first).toMatchObject({ outcome: "failed", cleanupPending: !cleanupConfirmed });
      expect(first.failure).toEqual({
        code: "cleanup_pending",
        message: "Managed device deletion is pending",
        retryable: cleanupConfirmed,
      });
      const scopeKey = (await options.store.listResources())[0].scopeKey;
      const reopened = new SessionBroker({
        ...options,
        store: registry.sessionBrokerStore(scopeKey),
      });
      expect(await reopened.ownedStatus(request.requestId, "owner-token")).toEqual(first);
      expect(await reopened.prepare(request, "owner-token")).toEqual(first);
      devices.canDestroy = true;
      await reopened.recover();
      expect((await reopened.status(request.requestId))?.failure).toEqual({
        code: "cleanup_pending",
        message: "Managed device deletion is pending",
        retryable: true,
      });
    },
  );

  test("an abandonment committed while the ready receipt is assembled is not reported ready", async () => {
    const activate = options.store.activate.bind(options.store);
    const listResources = options.store.listResources.bind(options.store);
    const listResourcesSpy = spyOn(options.store, "listResources");
    spyOn(options.store, "activate").mockImplementationOnce(async (...args) => {
      const request = await activate(...args);
      listResourcesSpy.mockImplementationOnce(async () => {
        await options.store.abandon("raced", options.owner, "owner-token");
        return listResources();
      });
      return request;
    });
    const result = await broker.prepare(config("raced"), "owner-token");
    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe(SESSION_REQUEST_ABANDONED_CODE);
  });
});
