import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import type {
  SlotBindingCommit,
  SlotScopeIdentity,
} from "../../../src/daemon/managedSlots/slotRegistry";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../db/withFileBackedDb";

const IDENTITY: SlotScopeIdentity = {
  managedHostScope: "host-1",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const INIT = { role: "primary", platform: "android" as const, requestedSpec: { apiLevel: 35 } };
const UNBOUND = { generation: 0, stableDeviceId: null };

function bind(stableDeviceId: string): SlotBindingCommit {
  return {
    stableDeviceId,
    deviceName: stableDeviceId,
    resolvedSpec: { apiLevel: 35 },
    specFingerprint: "fp",
    state: "ready",
  };
}

async function readyScopeKey(registry: SqliteSlotRegistry): Promise<string> {
  const scope = await registry.ensureScope(IDENTITY);
  if (scope.kind !== "ready") {
    throw new Error(`scope not ready: ${scope.kind}`);
  }
  return scope.scope.scopeKey;
}

describe("SqliteSlotRegistry on a shared file", () => {
  const getHarness = bindFileBackedDbHarness();

  test(
    "two connections migrate one fresh file concurrently and share one authority",
    async () => {
      const dbPath = join(
        await getHarness().makeTempDbDir("am-slots-"),
        "registry",
        "slots.sqlite",
      );
      const [a, b] = await Promise.all([
        openSqliteSlotRegistry({ dbPath }),
        openSqliteSlotRegistry({ dbPath }),
      ]);
      try {
        // Two connections in ONE process must not interleave write transactions: bun:sqlite's
        // busy_timeout blocks the JS thread the other connection's open transaction needs. Each
        // daemon owns one connection, so true concurrency is covered by the child-process test.
        const scopeKey = await readyScopeKey(a);
        const key = { scopeKey, slotIndex: 0 };
        expect(await a.initSlot(key, INIT)).toMatchObject({ kind: "ready", created: true });
        expect(await b.initSlot(key, INIT)).toMatchObject({ kind: "ready", created: false });

        const fromA = await a.commitBinding(key, UNBOUND, bind("avd-a"));
        const fromB = await b.commitBinding(key, UNBOUND, bind("avd-b"));
        expect([fromA.kind, fromB.kind]).toEqual(["committed", "stale_binding"]);

        const winner = "avd-a";
        const other = { scopeKey, slotIndex: 1 };
        await b.initSlot(other, INIT);
        expect((await b.commitBinding(other, UNBOUND, bind(winner))).kind).toBe(
          "device_assigned_elsewhere",
        );
        expect(await b.isDeviceAssignedToValidSlot("android", winner)).toBe(true);

        expect((await a.beginScopeInvalidation(scopeKey, "operator_reset")).kind).toBe(
          "invalidating",
        );
        expect((await b.beginScopeInvalidation(scopeKey, "operator_reset")).kind).toBe(
          "already_invalidating",
        );
        expect((await b.ensureScope(IDENTITY)).kind).toBe("scope_invalidated");
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
      const dbPath = join(await getHarness().makeTempDbDir("am-slots-"), "slots.sqlite");
      const first = await openSqliteSlotRegistry({ dbPath });
      let scopeKey: string;
      try {
        scopeKey = await readyScopeKey(first);
        await first.initSlot({ scopeKey, slotIndex: 0 }, INIT);
        await first.commitBinding({ scopeKey, slotIndex: 0 }, UNBOUND, bind("avd-1"));
      } finally {
        await first.close();
      }
      const reopened = await openSqliteSlotRegistry({ dbPath });
      try {
        expect(await reopened.getAssignment({ scopeKey, slotIndex: 0 })).toMatchObject({
          generation: 1,
          stableDeviceId: "avd-1",
          state: "ready",
          execOwner: null,
          requestedSpec: { apiLevel: 35 },
        });
        expect(await reopened.isDeviceAssignedToValidSlot("android", "avd-1")).toBe(true);
      } finally {
        await reopened.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  test(
    "a second process racing the same slot and device cannot double-assign",
    async () => {
      const dir = await getHarness().makeTempDbDir("am-slots-");
      const dbPath = join(dir, "slots.sqlite");
      const goFile = join(dir, "go");
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "fixtures/slotRegistryChild.ts"),
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
      const parent = await openSqliteSlotRegistry({ dbPath });
      try {
        const scopeKey = await readyScopeKey(parent);
        const key = { scopeKey, slotIndex: 0 };
        const otherKey = { scopeKey, slotIndex: 1 };
        await parent.initSlot(key, INIT);
        await parent.initSlot(otherKey, INIT);
        // Release both racers only once the child has opened, migrated and initialized.
        expect(await stdout.ready).toBe(true);
        writeFileSync(goFile, "");
        const [sameSlot, sameDevice] = await Promise.all([
          parent.commitBinding(key, UNBOUND, bind("avd-parent")),
          parent.commitBinding(otherKey, UNBOUND, bind("avd-shared")),
        ]);
        expect(await child.exited).toBe(0);
        const childResult: { kind: string } = JSON.parse(
          (await stdout.all).trim().split("\n").at(-1) ?? "{}",
        );

        // Exactly one writer won slot 0.
        expect([sameSlot.kind, childResult.kind].sort()).toEqual(["committed", "stale_binding"]);
        // avd-shared ended up in at most one slot, whichever order the processes ran in.
        const holder = await parent.findDeviceHolder("android", "avd-shared");
        const assignments = await parent.listAssignments(scopeKey);
        const holders = assignments.filter((slot) => slot.stableDeviceId === "avd-shared");
        expect(holders.length).toBeLessThanOrEqual(1);
        if (sameDevice.kind === "committed") {
          expect(holder).toMatchObject({ kind: "slot", assignment: { slotIndex: 1 } });
          expect(childResult.kind).not.toBe("committed");
        } else {
          expect(["device_assigned_elsewhere"]).toContain(sameDevice.kind);
          expect(holder).toMatchObject({ kind: "slot", assignment: { slotIndex: 0 } });
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
