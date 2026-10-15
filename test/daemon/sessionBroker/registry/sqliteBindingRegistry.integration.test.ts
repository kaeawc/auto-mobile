import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type {
  BindingBindingCommit,
  BindingScopeIdentity,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../../db/withFileBackedDb";

import { retryBusyRegistryWrite } from "./fixtures/retryBusyRegistryWrite";

const IDENTITY: BindingScopeIdentity = {
  managedHostScope: "host-1",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const INIT = { role: "primary", platform: "android" as const, requestedSpec: { apiLevel: 35 } };
const UNBOUND = { generation: 0, stableDeviceId: null };

function bind(stableDeviceId: string): BindingBindingCommit {
  return {
    stableDeviceId,
    deviceName: stableDeviceId,
    resolvedSpec: { apiLevel: 35 },
    specFingerprint: "fp",
    state: "ready",
  };
}

async function readyScopeKey(registry: SqliteBindingRegistry): Promise<string> {
  const scope = await registry.ensureScope(IDENTITY);
  if (scope.kind !== "ready") {
    throw new Error(`scope not ready: ${scope.kind}`);
  }
  return scope.scope.scopeKey;
}

describe("SqliteBindingRegistry on a shared file", () => {
  const getHarness = bindFileBackedDbHarness();

  test(
    "two connections migrate one fresh file concurrently and share one authority",
    async () => {
      const dbPath = join(
        await getHarness().makeTempDbDir("am-bindings-"),
        "registry",
        "slots.sqlite",
      );
      const [a, b] = await Promise.all([
        openSqliteBindingRegistry({ dbPath }),
        openSqliteBindingRegistry({ dbPath }),
      ]);
      try {
        // Two connections in ONE process must not interleave write transactions: bun:sqlite's
        // busy_timeout blocks the JS thread the other connection's open transaction needs. Each
        // daemon owns one connection, so true concurrency is covered by the child-process test.
        const scopeKey = await readyScopeKey(a);
        const key = { scopeKey, bindingIndex: 0 };
        expect(await a.initBinding(key, INIT)).toMatchObject({ kind: "ready", created: true });
        expect(await b.initBinding(key, INIT)).toMatchObject({ kind: "ready", created: false });

        const fromA = await a.commitBinding(key, UNBOUND, bind("avd-a"));
        const fromB = await b.commitBinding(key, UNBOUND, bind("avd-b"));
        expect([fromA.kind, fromB.kind]).toEqual(["committed", "stale_binding"]);

        const winner = "avd-a";
        const other = { scopeKey, bindingIndex: 1 };
        await b.initBinding(other, INIT);
        expect((await b.commitBinding(other, UNBOUND, bind(winner))).kind).toBe(
          "device_assigned_elsewhere",
        );
        expect(await b.isDeviceAssignedToValidBinding("android", winner)).toBe(true);
      } finally {
        await a.close();
        await b.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  test(
    "assignments survive a close and reopen without any session",
    async () => {
      const dbPath = join(await getHarness().makeTempDbDir("am-bindings-"), "slots.sqlite");
      const first = await openSqliteBindingRegistry({ dbPath });
      let scopeKey: string;
      try {
        scopeKey = await readyScopeKey(first);
        await first.initBinding({ scopeKey, bindingIndex: 0 }, INIT);
        await first.commitBinding({ scopeKey, bindingIndex: 0 }, UNBOUND, bind("avd-1"));
      } finally {
        await first.close();
      }
      const reopened = await openSqliteBindingRegistry({ dbPath });
      try {
        expect(await reopened.getAssignment({ scopeKey, bindingIndex: 0 })).toMatchObject({
          generation: 1,
          stableDeviceId: "avd-1",
          state: "ready",
          execOwner: null,
          requestedSpec: { apiLevel: 35 },
        });
        expect(await reopened.isDeviceAssignedToValidBinding("android", "avd-1")).toBe(true);
      } finally {
        await reopened.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  test(
    "a second process racing the same binding and device cannot double-assign",
    async () => {
      // Busy writes are re-driven; compare-and-set still permits exactly one binding winner.
      // Eight attempts schedule 2.575 s of backoff, plus bounded busy quiet time, well below 30 s.
      const dir = await getHarness().makeTempDbDir("am-bindings-");
      const dbPath = join(dir, "slots.sqlite");
      const goFile = join(dir, "go");
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "fixtures/bindingRegistryChild.ts"),
          dbPath,
          goFile,
          JSON.stringify(IDENTITY),
          "0",
          "avd-shared",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = collectChildStdout(child.stdout);
      const stderrText = new Response(child.stderr).text();
      const { result: parent } = await retryBusyRegistryWrite(() =>
        openSqliteBindingRegistry({ dbPath }),
      );
      try {
        const { result: scopeKey } = await retryBusyRegistryWrite(() => readyScopeKey(parent));
        const key = { scopeKey, bindingIndex: 0 };
        const otherKey = { scopeKey, bindingIndex: 1 };
        await retryBusyRegistryWrite(() => parent.initBinding(key, INIT));
        await retryBusyRegistryWrite(() => parent.initBinding(otherKey, INIT));
        // Release both racers only once the child has opened, migrated and initialized.
        expect(await stdout.ready).toBe(true);
        writeFileSync(goFile, "");
        const [sameBinding, sameDevice] = await Promise.all([
          retryBusyRegistryWrite(() => parent.commitBinding(key, UNBOUND, bind("avd-parent"))).then(
            ({ result }) => result,
          ),
          retryBusyRegistryWrite(() =>
            parent.commitBinding(otherKey, UNBOUND, bind("avd-shared")),
          ).then(({ result }) => result),
        ]);
        expect(await child.exited).toBe(0);
        const childResult: { kind: string } = JSON.parse(
          (await stdout.all).trim().split("\n").at(-1) ?? "{}",
        );

        // Exactly one writer won binding 0.
        expect([sameBinding.kind, childResult.kind].sort()).toEqual(["committed", "stale_binding"]);
        // avd-shared ended up in at most one binding, whichever order the processes ran in.
        const holder = await parent.findDeviceHolder("android", "avd-shared");
        const assignments = await parent.listAssignments(scopeKey);
        const holders = assignments.filter((binding) => binding.stableDeviceId === "avd-shared");
        expect(holders.length).toBeLessThanOrEqual(1);
        if (sameDevice.kind === "committed") {
          expect(holder).toMatchObject({ kind: "binding", assignment: { bindingIndex: 1 } });
          expect(childResult.kind).not.toBe("committed");
        } else {
          expect(["device_assigned_elsewhere"]).toContain(sameDevice.kind);
          expect(holder).toMatchObject({ kind: "binding", assignment: { bindingIndex: 0 } });
        }
      } finally {
        await parent.close();
        child.kill();
        await child.exited;
        const stderr = await stderrText;
        if (stderr.trim().length > 0 && child.exitCode !== 0) {
          console.error(stderr);
        }
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});

interface ChildOutput {
  /** Resolves once the child printed `ready` (opened, migrated and initialized), or on EOF. */
  ready: Promise<boolean>;
  /** Everything the child printed. */
  all: Promise<string>;
}

function collectChildStdout(stream: ReadableStream<Uint8Array>): ChildOutput {
  const decoder = new TextDecoder();
  let text = "";
  let markReady: (ready: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolveReady) => {
    markReady = resolveReady;
  });
  const all = (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes("ready\n")) {
        markReady(true);
      }
    }
    markReady(false);
    return text;
  })();
  return { ready, all };
}
