/**
 * Child-process half of the cross-process binding registry test. Opens the registry file named by
 * argv[2] (migrating it concurrently with the parent), waits for the parent's go file, then
 * races one compare-and-set binding of `bindingIndex` at generation 0 and prints the result as JSON.
 */
import { existsSync } from "node:fs";
import { openSqliteBindingRegistry } from "../../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BindingScopeIdentity } from "../../../../../src/daemon/sessionBroker/registry/bindingRegistry";

import { retryBusyRegistryWrite } from "./retryBusyRegistryWrite";

const [dbPath, goFile, identityJson, bindingIndexArg, stableDeviceId] = process.argv.slice(2);
const identity: BindingScopeIdentity = JSON.parse(identityJson);
const bindingIndex = Number.parseInt(bindingIndexArg, 10);

const { result: registry } = await retryBusyRegistryWrite(() =>
  openSqliteBindingRegistry({ dbPath }),
);
try {
  const { result: scope } = await retryBusyRegistryWrite(() => registry.ensureScope(identity));
  if (scope.kind !== "ready") {
    throw new Error(`child scope not ready: ${scope.kind}`);
  }
  const key = { scopeKey: scope.scope.scopeKey, bindingIndex };
  await retryBusyRegistryWrite(() =>
    registry.initBinding(key, { role: "primary", platform: "android", requestedSpec: {} }),
  );
  process.stdout.write("ready\n");
  while (!existsSync(goFile)) {
    await Bun.sleep(1);
  }
  const { result, attempts } = await retryBusyRegistryWrite(() =>
    registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId,
        deviceName: stableDeviceId,
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
      },
    ),
  );
  process.stdout.write(`${JSON.stringify({ kind: result.kind, attempts })}\n`);
} finally {
  await registry.close();
}
