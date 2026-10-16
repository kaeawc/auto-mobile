import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { openSqliteBindingRegistry } from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BrokerAdmissionInput } from "../../../src/daemon/sessionBroker/store";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../db/withFileBackedDb";

const SCOPE = {
  managedHostScope: "test-host",
  runnerNamespace: "broker",
  runnerIncarnation: "private",
};
const OWNER = { daemonId: "original", pid: process.pid };

function input(requestId: string): BrokerAdmissionInput {
  return {
    requestId,
    owner: OWNER,
    fingerprint: `same-parameters:${requestId}`,
    parameters: { device: "phone" },
    limits: { totalDeviceCap: 1, sessionCap: 1 },
    resolveCreation: () => ({ platform: "ios", model: "phone", runtime: "27" }),
    matches: () => false,
  };
}

interface ChildResult {
  kind: string;
  resourceId: string | null;
}

function contender(dbPath: string, scopeKey: string, requestId: string) {
  const ready = Promise.withResolvers<void>();
  const result = Promise.withResolvers<ChildResult>();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/admissionChild.ts"),
      dbPath,
      scopeKey,
      requestId,
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env, AUTOMOBILE_LOG_DIR: join(dirname(dbPath), "logs") },
      ipc(message: unknown) {
        if (!message || typeof message !== "object" || !("phase" in message)) {
          return;
        }
        if (message.phase === "ready") {
          ready.resolve();
        } else if (
          message.phase === "result" &&
          "kind" in message &&
          typeof message.kind === "string" &&
          "resourceId" in message &&
          (message.resourceId === null || typeof message.resourceId === "string")
        ) {
          result.resolve({ kind: message.kind, resourceId: message.resourceId });
        }
      },
    },
  );
  // An early child exit fails the observable gates; no filesystem polling or coordination sleeps.
  void child.exited.then((code) => {
    ready.reject(new Error(`Admission child exited before ready (${code})`));
    result.reject(new Error(`Admission child exited before result (${code})`));
  });
  // Both gates are observed even when another contender fails before the parent reaches them.
  void ready.promise.catch(() => {});
  void result.promise.catch(() => {});
  return { child, ready: ready.promise, result: result.promise };
}

async function contend(dbPath: string, scopeKey: string, ids: string[]): Promise<ChildResult[]> {
  const children: ReturnType<typeof contender>[] = [];
  const deadline = defaultTimer.setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
  }, 15_000);
  try {
    for (const id of ids) {
      children.push(contender(dbPath, scopeKey, id));
    }
    await Promise.all(children.map((entry) => entry.ready));
    for (const { child } of children) {
      child.send("begin");
    }
    const results = await Promise.all(children.map((entry) => entry.result));
    expect(await Promise.all(children.map((entry) => entry.child.exited))).toEqual(
      ids.map(() => 0),
    );
    return results;
  } finally {
    defaultTimer.clearTimeout(deadline);
    for (const { child } of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    await Promise.all(children.map((entry) => entry.child.exited));
  }
}

describe("session broker durable process boundary", () => {
  const harness = bindFileBackedDbHarness();

  async function database() {
    const dir = await harness().makeTempDbDir("session-broker-");
    const dbPath = join(dir, "slots.sqlite");
    const registry = await openSqliteBindingRegistry({ dbPath });
    try {
      const scope = await registry.ensureScope(SCOPE);
      if (scope.kind !== "ready") {
        throw new Error("Scope unavailable");
      }
      return { dbPath, scopeKey: scope.scope.scopeKey };
    } finally {
      await registry.close();
    }
  }

  test(
    "reopen retains failed cleanup and its capacity until confirmed absent",
    async () => {
      const { dbPath, scopeKey } = await database();
      const first = await openSqliteBindingRegistry({ dbPath });
      let ticket;
      try {
        const store = first.sessionBrokerStore(scopeKey);
        expect((await store.admit(input("interrupted"))).kind).toBe("create");
        ticket = await store.fail("interrupted", OWNER, "native response lost");
      } finally {
        await first.close();
      }
      if (!ticket) {
        throw new Error("Missing durable destruction ticket");
      }
      const restarted = await openSqliteBindingRegistry({ dbPath });
      try {
        const store = restarted.sessionBrokerStore(scopeKey);
        expect(await store.admit(input("interrupted"))).toMatchObject({
          kind: "existing",
          request: { state: "failed" },
        });
        expect(await store.admit(input("blocked"))).toMatchObject({ kind: "refused" });
        expect((await store.listResources()).map((resource) => resource.state)).toEqual([
          "destroying",
        ]);
        expect(await store.confirmDestroyed(ticket)).toBe(true);
        expect((await store.admit(input("next"))).kind).toBe("create");
        expect(await store.admit(input("interrupted"))).toMatchObject({
          kind: "existing",
          request: { state: "failed" },
        });
      } finally {
        await restarted.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  test(
    "separate processes cannot oversubscribe one device or session admission",
    async () => {
      const { dbPath, scopeKey } = await database();
      const results = await contend(
        dbPath,
        scopeKey,
        Array.from({ length: 6 }, (_, i) => `request-${i}`),
      );
      expect(results.filter((result) => result.kind === "create")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "refused")).toHaveLength(5);
      const registry = await openSqliteBindingRegistry({ dbPath });
      try {
        expect(await registry.sessionBrokerStore(scopeKey).listResources()).toHaveLength(1);
      } finally {
        await registry.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  test(
    "separate processes replay one identity as one reservation",
    async () => {
      const { dbPath, scopeKey } = await database();
      const results = await contend(
        dbPath,
        scopeKey,
        Array.from({ length: 4 }, () => "same-request"),
      );
      expect(results.filter((result) => result.kind === "create")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "existing")).toHaveLength(3);
      expect(new Set(results.map((result) => result.resourceId)).size).toBe(1);
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
