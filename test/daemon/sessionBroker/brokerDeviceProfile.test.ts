import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import type { SessionDevicePreparationOptions } from "../../../src/daemon/sessionBroker/devicePort";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import type { DeviceProfileSelector } from "../../../src/models/ManufacturerProfileIds";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { androidCatalog, androidDefaults } from "../../devices/sessionRequirements/fixtures";
import { FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";

const OWNER = { daemonId: "broker-daemon", pid: 101, processGenerationToken: "start-a" };

function config(requestId: string, deviceProfile?: DeviceProfileSelector): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "android",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
      ...(deviceProfile ? { deviceProfile } : {}),
    },
  };
}

describe("session broker deviceProfile (#14058)", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let broker: SessionBroker;
  let seen: SessionDevicePreparationOptions[];

  beforeAll(async () => {
    // Warm SQLite/migration setup outside the per-test budget.
    await (await openSqliteBindingRegistry({ dbPath: ":memory:" })).close();
  });

  beforeEach(async () => {
    registry = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    const scope = await registry.ensureScope({
      managedHostScope: "private-host",
      runnerNamespace: "private-broker",
      runnerIncarnation: "persistent",
    });
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    devices = new FakeNativePort(registry);
    seen = [];
    devices.prepareHook = async (options) => {
      seen.push(options);
    };
    broker = new SessionBroker({
      store: registry.sessionBrokerStore(scope.scope.scopeKey, new CountingIdGenerator("resource")),
      devices,
      owner: OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 1 },
      catalog: async () => androidCatalog(),
      defaults: () => androidDefaults(),
    });
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  test("the requested profile reaches device preparation", async () => {
    const profile: DeviceProfileSelector = { manufacturerProfile: "samsung-oneui" };

    const result = await broker.prepare(config("with-profile", profile), "owner");

    expect(result.outcome).toBe("ready");
    expect(seen.map((options) => options.deviceProfile)).toEqual([profile]);
  });

  test("a request without one prepares without a profile", async () => {
    await broker.prepare(config("plain"), "owner");
    expect(seen.map((options) => options.deviceProfile)).toEqual([undefined]);
  });

  test("a capability the profile cannot emulate refuses before anything is reserved", async () => {
    const result = await broker.prepare(
      config("needs-dex", { manufacturerProfile: "samsung-oneui", requires: ["samsung-dex"] }),
      "owner",
    );

    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "requires_real_device", retryable: false },
    });
    expect(result.failure?.message).toContain("cannot emulate samsung-dex");
    expect(devices.prepared).toEqual([]);
  });

  test("an emulatable requirement is not refused", async () => {
    const result = await broker.prepare(
      config("needs-cutout", { manufacturerProfile: "samsung-oneui", requires: [] }),
      "owner",
    );
    expect(result.outcome).toBe("ready");
  });
});
