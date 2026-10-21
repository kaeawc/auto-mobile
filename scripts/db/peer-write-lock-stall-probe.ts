import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";

const paths = [
  "app-db-session-upsert",
  "app-db-session-release",
  "app-db-transaction",
  "binding-registry-ensure-scope",
  "binding-registry-journal",
] as const;
const { values } = parseArgs({
  options: {
    holds: { type: "string" },
    "max-stall-ms": { type: "string" },
    paths: { type: "string" },
  },
});
const holds = (values.holds ?? "1000,3000,8000,20000").split(",").map(Number);
const maxStallMs = Number(values["max-stall-ms"] ?? 1000);
const selectedPaths = values.paths?.split(",") ?? paths;
if (
  holds.some((ms) => !Number.isSafeInteger(ms) || ms <= 0) ||
  !Number.isFinite(maxStallMs) ||
  maxStallMs <= 0 ||
  selectedPaths.some((name) => !paths.some((path) => path === name))
) {
  console.error("Expected positive holds/max-stall-ms and known path names:", paths);
  process.exit(2);
}

const directory = await mkdtemp(join(tmpdir(), "auto-mobile-peer-lock-probe-"));
// Redirect before any production import, including logging and legacy DB overrides.
process.env.AUTOMOBILE_DB_DIR = directory;
delete process.env.AUTOMOBILE_DB_PATH;
delete process.env.AUTO_MOBILE_DB_PATH;
process.env.AUTOMOBILE_DATA_DIR = directory;
process.env.AUTOMOBILE_LOG_DIR = join(directory, "logs");
process.env.AUTOMOBILE_LOG_LEVEL = "none";
process.env.AUTOMOBILE_APPEARANCE_SYNC = "0";

try {
  const database = await import("../../src/db/database");
  const dbPath = database.getDatabasePath();
  const resolvedRelative = relative(directory, dbPath);
  if (!resolvedRelative || resolvedRelative.startsWith("..") || isAbsolute(resolvedRelative)) {
    console.error(`Refusing database outside probe directory: ${dbPath}`);
    process.exitCode = 2;
  } else {
    const { DeviceSessionRepository } = await import("../../src/db/deviceSessionRepository");
    const { openSqliteBindingRegistry } =
      await import("../../src/daemon/sessionBroker/registry/sqliteBindingRegistry");
    const windows = await import("../../src/daemon/sessionLivenessWindows");
    const { raceWithDeadline } = await import("../../src/utils/raceWithDeadline");
    const { defaultTimer } = await import("../../src/utils/SystemTimer");
    const { sql } = await import("kysely");
    console.log(
      JSON.stringify({
        budgets: {
          heartbeatIntervalMs: windows.PROXY_HEARTBEAT_INTERVAL_MS,
          ownerLeaseMs: windows.DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
          noHeartbeatReleaseBudgetMs: windows.NO_HEARTBEAT_RELEASE_BUDGET_MS,
          idleTimeoutMs: windows.DEFAULT_SESSION_IDLE_TIMEOUT_MS,
          maxStallMs,
        },
        bunVersion: Bun.version,
        platform: process.platform,
      }),
    );
    const db = database.getDatabase();
    let registry: Awaited<ReturnType<typeof openSqliteBindingRegistry>> | undefined;
    try {
      await database.ensureMigrations();
      await sql`CREATE TABLE IF NOT EXISTS peer_probe (value INTEGER)`.execute(db);
      const registryPath = join(directory, "binding-registry.db");
      registry = await openSqliteBindingRegistry({ dbPath: registryPath });
      const repository = new DeviceSessionRepository();
      let caseIndex = 0;
      for (const path of selectedPaths) {
        for (const holdMs of holds) {
          const id = `probe-${caseIndex++}`;
          const now = Date.now();
          const session = {
            sessionUuid: id,
            deviceId: "emulator-probe",
            platform: "android" as const,
            createdAtMs: now,
            lastUsedAtMs: now,
            expiresAtMs: now + 120_000,
            sessionTimeoutMs: 120_000,
            heartbeatTimeoutMs: 4000,
            hasReceivedHeartbeat: true,
          };
          let operation: () => Promise<unknown>;
          if (path === "app-db-session-upsert") {
            operation = () => repository.upsertActiveSession(session);
          } else if (path === "app-db-session-release") {
            await repository.upsertActiveSession(session);
            operation = () => repository.markReleased(id, "released", Date.now(), "probe");
          } else if (path === "app-db-transaction") {
            operation = () =>
              db
                .transaction()
                .execute((trx) => sql`INSERT INTO peer_probe VALUES (2)`.execute(trx));
          } else if (path === "binding-registry-ensure-scope") {
            operation = () =>
              registry!.ensureScope({
                managedHostScope: "probe",
                runnerNamespace: id,
                runnerIncarnation: id,
              });
          } else {
            const scope = await registry.ensureScope({
              managedHostScope: "probe",
              runnerNamespace: id,
              runnerIncarnation: id,
            });
            if (scope.kind !== "ready") {
              throw new Error(`Scope setup failed: ${scope.kind}`);
            }
            const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
            const initialized = await registry.initBinding(key, {
              role: "primary",
              platform: "android",
              requestedSpec: {},
            });
            if (initialized.kind !== "ready") {
              throw new Error(`Binding setup failed: ${initialized.kind}`);
            }
            operation = () =>
              registry!.openBindingJournal(key, {
                kind: "create",
                phase: "intent",
                target: {
                  oldStableId: null,
                  oldName: null,
                  newName: id,
                  newStableId: null,
                  requestedSpec: {},
                  resolvedSpec: {},
                  specFingerprint: null,
                },
                owner: { daemonId: id, pid: process.pid, processGenerationToken: id },
                assignment: {
                  kind: "state",
                  expected: { generation: 0, stableDeviceId: null },
                  state: "provisioning",
                },
              });
          }
          const holder = Bun.spawn(
            [
              process.execPath,
              join(dirname(fileURLToPath(import.meta.url)), "peer-write-lock-holder.ts"),
              path.startsWith("app-db-") ? dbPath : registryPath,
              String(holdMs),
            ],
            { stdout: "pipe", stderr: "inherit" },
          );
          try {
            const reader = holder.stdout.getReader();
            await raceWithDeadline(
              (async () => {
                let output = "";
                const decoder = new TextDecoder();
                while (!output.includes("LOCKED\n")) {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    throw new Error("Holder exited before LOCKED");
                  }
                  output += decoder.decode(chunk.value, { stream: true });
                }
              })(),
              { timer: defaultTimer, timeoutMs: 10_000, label: "peer lock acquisition" },
            );
            reader.releaseLock();
            let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
            try {
              histogram = monitorEventLoopDelay({ resolution: 5 });
              histogram.enable();
            } catch (error) {
              // Timer drift remains the deciding measurement on runtimes without this API.
              console.error("Event-loop histogram unavailable; using timer drift:", error);
              histogram = undefined;
            }
            let previous = performance.now();
            let maxLoopStallMs = 0;
            const sample = () => {
              const now = performance.now();
              maxLoopStallMs = Math.max(maxLoopStallMs, now - previous);
              previous = now;
            };
            const sampler = defaultTimer.setInterval(sample, 5);
            const start = performance.now();
            let totalMs: number;
            let outcome = "ok";
            try {
              await operation();
            } catch (error) {
              // BUSY is an expected diagnostic outcome; preserve its structured code.
              let cause: unknown = error;
              let code = "unknown";
              // Repository errors can wrap the dialect's identity-preserved SQLite cause.
              for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
                if ("code" in cause && typeof cause.code === "string") {
                  code = cause.code;
                  break;
                }
                cause = cause.cause;
              }
              outcome = `${error instanceof Error ? error.name : "UnknownError"} ${code}`;
              console.error(`${path}: ${outcome}`);
            } finally {
              totalMs = performance.now() - start;
              // Include a final synchronous block even when the operation settles in microtasks.
              sample();
              await Bun.sleep(10);
              defaultTimer.clearInterval(sampler);
              histogram?.disable();
              maxLoopStallMs = Math.max(maxLoopStallMs, (histogram?.max ?? 0) / 1_000_000);
            }
            console.log(JSON.stringify({ path, holdMs, totalMs, maxLoopStallMs, outcome }));
            if (maxLoopStallMs > maxStallMs) {
              process.exitCode = 1;
            }
            const exitCode = await raceWithDeadline(holder.exited, {
              timer: defaultTimer,
              timeoutMs: holdMs + 10_000,
              label: "peer lock release",
            });
            if (exitCode !== 0) {
              throw new Error(`Holder exited ${exitCode}`);
            }
          } finally {
            if (holder.exitCode === null) {
              holder.kill();
            }
            await holder.exited;
          }
        }
      }
    } finally {
      try {
        await registry?.close();
      } finally {
        await database.closeDatabase();
      }
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
