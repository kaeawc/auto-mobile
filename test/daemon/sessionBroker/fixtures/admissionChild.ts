/** Real process contender. Parent gates admission after every child has opened the same file. */
import { openSqliteSlotRegistry } from "../../../../src/daemon/managedSlots/sqliteSlotRegistry";

const [dbPath, scopeKey, requestId] = process.argv.slice(2);
const begin = Promise.withResolvers<void>();
process.on("message", (message) => {
  if (message === "begin") {
    begin.resolve();
  }
});

const registry = await openSqliteSlotRegistry({ dbPath });
try {
  process.send?.({ phase: "ready" });
  await begin.promise;
  const result = await registry.sessionBrokerStore(scopeKey).admit({
    requestId,
    fingerprint: `same-parameters:${requestId}`,
    parameters: { device: "phone" },
    owner: { daemonId: `child-${process.pid}`, pid: process.pid },
    limits: { totalDeviceCap: 1, sessionCap: 1 },
    resolveCreation: () => ({ platform: "ios", model: "phone", runtime: "27" }),
    matches: () => false,
  });
  process.send?.({ phase: "result", kind: result.kind, resourceId: result.request.resourceId });
} finally {
  await registry.close();
  process.disconnect?.();
}
