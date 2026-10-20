import {
  SessionBroker,
  type SessionBrokerOptions,
} from "../../../../src/daemon/sessionBroker/broker";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { SessionConfig } from "../../../../src/devices/sessionConfig";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { iosCatalog, iosDefaults } from "../../../devices/sessionRequirements/fixtures";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../../helpers/fakeSessionBrokerDevicePort";

export const EXPORT_IDENTITY = { prepareId: "prepare-1", requestDigest: "digest-1" };
export const EXPORT_TOKEN = "original-consumer-token";
export function exportConfig(requestId = "request-1"): SessionConfig {
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

export async function openExportHarness(
  dbPath = ":memory:",
  timer = new FakeTimer(),
  owner: BindingProcessIdentity = FAKE_BROKER_OWNER,
) {
  const registry = await openSqliteBindingRegistry({ dbPath, timer, isExecOwnerLive: () => false });
  const scope = await registry.ensureScope({
    managedHostScope: "export-host",
    runnerNamespace: "export-broker",
    runnerIncarnation: "persistent",
  });
  if (scope.kind !== "ready") {
    throw new Error("Missing export scope");
  }
  const store = registry.sessionBrokerStore(
    scope.scope.scopeKey,
    new CountingIdGenerator("export-resource"),
  );
  const devices = new FakeNativePort(registry, new CountingIdGenerator("export-session"), owner);
  const options: SessionBrokerOptions = {
    store,
    devices,
    owner,
    limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
    catalog: async () => iosCatalog(),
    defaults: () => iosDefaults(),
  };
  const broker = new SessionBroker(options);
  return { registry, store, devices, options, broker, timer, scopeKey: scope.scope.scopeKey };
}
