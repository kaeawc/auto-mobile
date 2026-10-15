import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BindingRegistry } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../../test/fakes/FakeTimer";

// Only this stable subset of the previous registry API is needed. No current implementation
// is imported: every domain write below goes through the archived code's exported methods.
type CaptureRegistry = Pick<
  BindingRegistry,
  | "ensureScope"
  | "initBinding"
  | "openBindingJournal"
  | "advanceBindingJournal"
  | "claimExecution"
  | "beginScopeInvalidation"
  | "completeScopeInvalidation"
  | "listFreeDevices"
  | "beginFreeDeviceDeletion"
  | "recordFreeDeviceDeletionAttempt"
  | "close"
>;

const [oldSrcRoot, outSql] = process.argv.slice(2);
if (!oldSrcRoot || !outSql) {
  throw new Error("Usage: bun registry-upgrade-fixture-driver.ts <oldSrcRoot> <out.sql>");
}
const root = resolve(oldSrcRoot);
// Set isolation before importing old modules, including their logger/database dependencies.
process.env.AUTOMOBILE_DATA_DIR = join(root, "data");
process.env.AUTOMOBILE_LOG_DIR = join(root, "log");
process.env.AUTOMOBILE_APPEARANCE_SYNC = "0";
const {
  openSqliteBindingRegistry,
}: {
  openSqliteBindingRegistry(options: {
    dbPath: string;
    timer: Timer;
    isExecOwnerLive: () => boolean;
  }): Promise<CaptureRegistry>;
} = await import(pathToFileURL(join(root, "src/daemon/managedSlots/sqliteSlotRegistry.ts")).href);

const timer = new FakeTimer();
timer.setCurrentTime(1_760_000_000_000);
const owner = {
  daemonId: "fixture-daemon-1",
  pid: 4242,
  processGenerationToken: "fixture-process-1",
};
const dbPath = join(root, "registry.sqlite");
const registry = await openSqliteBindingRegistry({ dbPath, timer, isExecOwnerLive: () => true });
try {
  for (const [runnerNamespace, ids] of [
    ["fixture-runner", ["fixture-avd-a", "fixture-avd-b"]],
    ["fixture-free-runner", ["fixture-avd-deleting", "fixture-avd-cached"]],
  ] as const) {
    const scope = await registry.ensureScope({
      managedHostScope: "fixture-host",
      runnerNamespace,
      runnerIncarnation: "fixture-incarnation-1",
    });
    if (scope.kind !== "ready") {
      throw new Error(`Scope capture refused: ${scope.kind}`);
    }
    for (const [bindingIndex, stableDeviceId] of ids.entries()) {
      const key = { scopeKey: scope.scope.scopeKey, bindingIndex };
      const requestedSpec = {
        runtime: "system-images;android-35;google_apis;arm64-v8a",
        deviceType: "pixel_8",
      };
      const resolvedSpec = { ...requestedSpec };
      const specFingerprint = "fixture-spec-fingerprint";
      const deviceName = `amslot-${stableDeviceId}`;
      const initialized = await registry.initBinding(key, {
        role: bindingIndex === 0 ? "primary" : "secondary",
        platform: "android",
        requestedSpec,
      });
      if (initialized.kind !== "ready") {
        throw new Error(`Binding capture refused: ${initialized.kind}`);
      }
      // openSlotJournal's atomic binding commit records a fixed synthetic creation result;
      // advanceSlotJournal makes committed history, without creating any native device.
      const created = await registry.openBindingJournal(key, {
        kind: "create",
        phase: "created",
        owner,
        target: {
          oldStableId: null,
          oldName: null,
          newName: deviceName,
          newStableId: stableDeviceId,
          requestedSpec,
          resolvedSpec,
          specFingerprint,
        },
        assignment: {
          kind: "commit",
          expected: { generation: 0, stableDeviceId: null },
          next: { stableDeviceId, deviceName, resolvedSpec, specFingerprint, state: "ready" },
        },
      });
      if (created.kind !== "opened") {
        throw new Error(`Journal capture refused: ${created.kind}`);
      }
      timer.advanceTime(10);
      const committed = await registry.advanceBindingJournal(created.entry.id, {
        owner,
        expectedPhase: "created",
        phase: "committed",
      });
      if (committed.kind !== "advanced") {
        throw new Error(`Commit capture refused: ${committed.kind}`);
      }
      if (runnerNamespace === "fixture-runner" && bindingIndex === 0) {
        const claimed = await registry.claimExecution(
          key,
          { generation: 1, stableDeviceId },
          { ...owner, sessionUuid: "fixture-session-1" },
        );
        if (claimed.kind !== "claimed") {
          throw new Error(`Owner capture refused: ${claimed.kind}`);
        }
      }
      if (runnerNamespace === "fixture-runner" && bindingIndex === 1) {
        // The lowest-level openSlotJournal API can record a release intent while preserving
        // the ready idle binding; no release worker or native restoration is invoked.
        const release = await registry.openBindingJournal(key, {
          kind: "release",
          phase: "intent",
          owner,
          target: {
            oldStableId: stableDeviceId,
            oldName: deviceName,
            newName: null,
            newStableId: null,
            requestedSpec,
            resolvedSpec,
            specFingerprint,
          },
          assignment: {
            kind: "state",
            expected: { generation: 1, stableDeviceId },
            state: "ready",
          },
        });
        if (release.kind !== "opened") {
          throw new Error(`Release capture refused: ${release.kind}`);
        }
      }
    }
    if (runnerNamespace === "fixture-free-runner") {
      // Permanent scope invalidation moves both bindings into the free pool through old code.
      const begun = await registry.beginScopeInvalidation(scope.scope.scopeKey, "operator_reset");
      if (begun.kind !== "invalidating") {
        throw new Error(`Invalidation capture refused: ${begun.kind}`);
      }
      const completed = await registry.completeScopeInvalidation(scope.scope.scopeKey);
      if (completed.kind !== "invalidated") {
        throw new Error(`Free-pool capture refused: ${completed.kind}`);
      }
    }
  }
  const pending = (await registry.listFreeDevices()).find(
    (row) => row.stableDeviceId === "fixture-avd-deleting",
  );
  if (!pending) {
    throw new Error("Missing captured free device");
  }
  // Migration 004's marker, attempt count and error are written only by its public deletion API.
  const deletion = await registry.beginFreeDeviceDeletion(pending, owner);
  if (deletion.kind !== "begun") {
    throw new Error(`Deletion capture refused: ${deletion.kind}`);
  }
  if (
    !(await registry.recordFreeDeviceDeletionAttempt(pending, owner, {
      error: "fixture native delete failed",
      nextAttemptAtMs: timer.now() + 1_000,
    }))
  ) {
    throw new Error("Deletion attempt capture refused");
  }
} finally {
  await registry.close();
}

// SQLite's quote() handles SQL literals (including NULL/blobs) rather than a local serializer.
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const db = new Database(dbPath, { readonly: true });
try {
  const schema = db
    .query<{ type: string; name: string; sql: string }, []>(
      `SELECT type, name, sql FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT GLOB 'sqlite_*' AND sql IS NOT NULL
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
    )
    .all();
  const lines = [
    "-- Captured binding registry: generated, do not edit.",
    `-- Source ref: ${process.env.CAPTURE_REGISTRY_REF ?? "unspecified (direct driver invocation)"}`,
    `-- Capture command: ${process.env.CAPTURE_REGISTRY_COMMAND ?? "unspecified (use the capture script)"}`,
    "-- Domain rows were produced by the source ref's registry/journal APIs, without devices.",
    "-- kysely_migration.timestamp is normalized in this dump to 2025-10-09T08:53:20.000Z.",
    "",
    ...schema.map((entry) => `${entry.sql};`),
  ];
  for (const table of schema.filter((entry) => entry.type === "table")) {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${identifier(table.name)})`)
      .all();
    const names = columns.map((column) => identifier(column.name));
    const quoted = columns.map((column) =>
      table.name === "kysely_migration" && column.name === "timestamp"
        ? "quote('2025-10-09T08:53:20.000Z')"
        : `quote(${identifier(column.name)})`,
    );
    const rows = db
      .query(
        `SELECT ${quoted.join(", ")} FROM ${identifier(table.name)} ORDER BY ${names.join(", ")}`,
      )
      .values();
    for (const row of rows) {
      lines.push(
        `INSERT INTO ${identifier(table.name)} (${names.join(", ")}) VALUES (${row.join(", ")});`,
      );
    }
  }
  mkdirSync(dirname(resolve(outSql)), { recursive: true });
  await Bun.write(outSql, `${lines.join("\n")}\n`);
} finally {
  db.close();
}
