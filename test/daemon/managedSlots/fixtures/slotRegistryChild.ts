/**
 * Child-process half of the cross-process slot registry test. Opens the registry file named by
 * argv[2] (migrating it concurrently with the parent), waits for the parent's go file, then
 * races one compare-and-set binding of `slotIndex` at generation 0 and prints the result as JSON.
 */
import { existsSync } from "node:fs";
import { openSqliteSlotRegistry } from "../../../../src/daemon/managedSlots/sqliteSlotRegistry";
import type { SlotScopeIdentity } from "../../../../src/daemon/managedSlots/slotRegistry";

const [dbPath, goFile, identityJson, slotIndexArg, stableDeviceId] = process.argv.slice(2);
const identity: SlotScopeIdentity = JSON.parse(identityJson);
const slotIndex = Number.parseInt(slotIndexArg, 10);

const registry = await openSqliteSlotRegistry({ dbPath });
try {
  const scope = await registry.ensureScope(identity);
  if (scope.kind !== "ready") {
    throw new Error(`child scope not ready: ${scope.kind}`);
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex };
  await registry.initSlot(key, { role: "primary", platform: "android", requestedSpec: {} });
  process.stdout.write("ready\n");
  while (!existsSync(goFile)) {
    await Bun.sleep(1);
  }
  const result = await registry.commitBinding(
    key,
    { generation: 0, stableDeviceId: null },
    {
      stableDeviceId,
      deviceName: stableDeviceId,
      resolvedSpec: {},
      specFingerprint: "fp",
      state: "ready",
    },
  );
  process.stdout.write(`${JSON.stringify({ kind: result.kind })}\n`);
} finally {
  await registry.close();
}
