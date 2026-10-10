import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  processJournalOwner,
  type ManagedSlotReconcileResult,
} from "../../../src/daemon/managedSlots/reconciler";
import {
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import type { SlotScopeIdentity } from "../../../src/daemon/managedSlots/slotRegistry";
import type { ExactDeviceSpecification } from "../../../src/devices/exactDeviceProvisioning";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../db/withFileBackedDb";
import {
  FileDeleter,
  FileDeviceState,
  FileInventory,
  FileProvisioner,
  type CrashPoint,
} from "./fixtures/fileDevicePorts";
import { FakeClaims, FakeMatcher } from "./fixtures/reconcilerFakes";

// #11179: a daemon SIGKILLed mid-replacement leaves its journal entry in the shared registry file.
// The next daemon, opening the same file, redrives it at startup and converges the slot without
// repeating the destructive step, and a later acquisition reuses the result.

const IDENTITY: SlotScopeIdentity = {
  managedHostScope: "host-1",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const OLD_SPEC: ExactDeviceSpecification = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-5",
  deviceType: IPHONE_16,
};
const NEW_SPEC: ExactDeviceSpecification = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: IPHONE_16,
};

function reconcilerFor(registry: SqliteSlotRegistry, state: FileDeviceState, daemonId: string) {
  return new ManagedSlotReconciler({
    registry,
    inventory: new FileInventory(state),
    matcher: new FakeMatcher(),
    resolver: new DefaultManagedSpecResolver(),
    provisioner: new FileProvisioner(state),
    deleter: new FileDeleter(state),
    claims: new FakeClaims(),
    timer: defaultTimer,
    // Default owner liveness (PID plus process generation): the SIGKILLed child reads as dead.
    journal: { owner: { ...processJournalOwner(), daemonId } },
  });
}

function expectReady(result: ManagedSlotReconcileResult) {
  if (result.outcome !== "ready") {
    throw new Error(`expected ready, got ${JSON.stringify(result.failure)}`);
  }
  return result;
}

async function reconcileSlot(
  registry: SqliteSlotRegistry,
  state: FileDeviceState,
  daemonId: string,
  spec: ExactDeviceSpecification,
) {
  const scope = await registry.ensureScope(IDENTITY);
  if (scope.kind !== "ready") {
    throw new Error(`scope not ready: ${scope.kind}`);
  }
  return reconcilerFor(registry, state, daemonId).reconcile({
    key: { scopeKey: scope.scope.scopeKey, slotIndex: 0 },
    role: "app",
    platform: "ios",
    requestedSpec: spec,
    deadlineMs: Date.now() + 60_000,
  });
}

/** Run the child daemon until it reaches `crash`, then SIGKILL it there. */
async function crashChildDaemon(dir: string, dbPath: string, statePath: string, crash: CrashPoint) {
  const markerPath = join(dir, `crashed-${crash}`);
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "fixtures/slotJournalCrashChild.ts"),
      dbPath,
      statePath,
      markerPath,
      crash,
      JSON.stringify(IDENTITY),
      JSON.stringify(NEW_SPEC),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  const deadline = Date.now() + 30_000;
  while (!existsSync(markerPath)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`child never reached ${crash} (exit ${child.exitCode})`);
    }
    await Bun.sleep(5);
  }
  child.kill("SIGKILL");
  await child.exited;
}

describe("slot journal redrive across a killed daemon", () => {
  const getHarness = bindFileBackedDbHarness();

  for (const crash of ["after-delete", "after-create"] as const) {
    test(
      `a daemon killed ${crash} is converged by the next daemon without repeated destructive work`,
      async () => {
        const dir = await getHarness().makeTempDbDir("am-slot-journal-");
        const dbPath = join(dir, "slots.sqlite");
        const state = new FileDeviceState(join(dir, "devices.json"));

        const seeding = await openSqliteSlotRegistry({ dbPath });
        let oldId: string;
        try {
          oldId = expectReady(await reconcileSlot(seeding, state, "seed", OLD_SPEC)).device
            .stableId;
        } finally {
          await seeding.close();
        }

        await crashChildDaemon(dir, dbPath, join(dir, "devices.json"), crash);

        const restarted = await openSqliteSlotRegistry({ dbPath });
        try {
          const [open] = await restarted.listOpenSlotJournal();
          expect(open).toMatchObject({ kind: "replace", owner: { daemonId: "child-daemon" } });

          // Daemon startup: one redrive pass adopts the dead child's entry and settles it.
          const pass = await reconcilerFor(restarted, state, "daemon-2").journal.runPass();
          expect(pass.settled).toEqual([expect.objectContaining({ entryId: open.id })]);
          expect(await restarted.listOpenSlotJournal()).toEqual([]);

          const converged = expectReady(
            await reconcileSlot(restarted, state, "daemon-2", NEW_SPEC),
          );
          const log = state.read().log;
          expect(log.filter((line) => line === `delete ${oldId}`)).toHaveLength(1);
          expect(log.filter((line) => line.startsWith("create "))).toHaveLength(2);
          expect(state.read().devices.map((device) => device.deviceId)).toEqual([
            converged.device.stableId,
          ]);
          expect(converged.disposition).toBe(crash === "after-create" ? "reused" : "created");
        } finally {
          await restarted.close();
        }

        // A later acquisition on a fresh connection reuses the committed device.
        const later = await openSqliteSlotRegistry({ dbPath });
        try {
          const before = state.read().log.length;
          const again = expectReady(await reconcileSlot(later, state, "daemon-3", NEW_SPEC));
          expect(again.disposition).toBe("reused");
          expect(state.read().log).toHaveLength(before);
        } finally {
          await later.close();
        }
      },
      WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
    );
  }
});
