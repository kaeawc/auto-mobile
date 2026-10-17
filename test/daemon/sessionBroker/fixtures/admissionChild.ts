/** Real process contender. Parent gates admission after every child has opened the same file. */
import { classifySqliteError } from "../../../../src/db/databaseFailureClassification";
import { BindingDiscoveryIncompleteError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { defaultTimer } from "../../../../src/utils/SystemTimer";

const [dbPath, scopeKey, requestId] = process.argv.slice(2);
const begin = Promise.withResolvers<void>();
process.on("message", (message) => {
  if (message === "begin") {
    begin.resolve();
  }
});

// The registry fails fast on a busy lock (one 250 ms busy_timeout) and leaves the retry to the
// caller, which yields the event loop first. A slow Windows fsync can hold a peer's write lock past
// one wait, so retry. Open and admit share one window that starts before open, matching the
// parent's 15 s kill deadline, which starts before spawn. A busy transaction rolled back; retrying
// replays the same request id.
const RETRY_DEADLINE_MS = 10_000;
const RETRY_DELAY_MS = 25;

function isRetryable(error: unknown): boolean {
  return (
    error instanceof BindingDiscoveryIncompleteError || classifySqliteError(error) === "retryable"
  );
}

async function withBusyRetry<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error) || defaultTimer.now() >= deadline) {
        throw error;
      }
      await defaultTimer.sleep(RETRY_DELAY_MS);
    }
  }
}

const deadline = defaultTimer.now() + RETRY_DEADLINE_MS;
const registry = await withBusyRetry(() => openSqliteBindingRegistry({ dbPath }), deadline);
try {
  process.send?.({ phase: "ready" });
  await begin.promise;
  const store = registry.sessionBrokerStore(scopeKey);
  const result = await withBusyRetry(
    () =>
      store.admit({
        requestId,
        fingerprint: `same-parameters:${requestId}`,
        parameters: { device: "phone" },
        owner: { daemonId: `child-${process.pid}`, pid: process.pid },
        limits: { totalDeviceCap: 1, sessionCap: 1 },
        resolveCreation: () => ({ platform: "ios", model: "phone", runtime: "27" }),
        matches: () => false,
      }),
    deadline,
  );
  process.send?.({ phase: "result", kind: result.kind, resourceId: result.request.resourceId });
} finally {
  await registry.close();
  process.disconnect?.();
}
