import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MANAGED_EXECUTION_SETTLEMENT_CAP_MS } from "../../../src/daemon/managedSlots/managedExecutionRelease";
import {
  createSlotExecOwnerLiveness,
  InFlightSlotReservations,
  withLiveExecutionSessions,
} from "../../../src/daemon/managedSlots/slotOwnerLiveness";
import type {
  SlotExecOwnerLiveness,
  SlotKey,
  SlotProcessIdentity,
  SlotRegistry,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { SlotScopeReset } from "../../../src/daemon/managedSlots/slotScopeReset";
import { openSqliteSlotRegistry } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { logger } from "../../../src/utils/logger";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// `reset-slot-scope --force` judges every slot before its bounded settle wait (`--wait-ms`,
// default 10 s, up to 60 s) so an abandoned slot can settle the scope within the wait. #11616: it
// reported those verdicts after the wait too, so a slot refused as `within_settlement_cap` with
// `remainingMs` shorter than the wait had outlived the cap by the time the command answered, yet
// the answer (and the CLI's stderr) still said "retry --force in <remainingMs>ms" and `--force`
// was never applied. The same held for a settling daemon that exited during the wait. The slots
// are judged again when the wait ends, before the command answers `pending`.
// docs/using/managed-slots.md: "`remainingMs` says when `--force` will apply."

const A: SlotProcessIdentity = {
  daemonId: "daemon-a",
  pid: 4242,
  processGenerationToken: "linux:boot:100",
};
const B: SlotProcessIdentity = {
  daemonId: "daemon-b",
  pid: 5151,
  processGenerationToken: "linux:boot:200",
};
const AVD = "amslot-test-0-g1";
const BINDING = { generation: 1, stableDeviceId: AVD };
const SCOPE = {
  managedHostScope: "host",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const WAIT_MS = 10_000;
const RESET = {
  runnerNamespace: SCOPE.runnerNamespace,
  runnerIncarnation: SCOPE.runnerIncarnation,
  waitMs: WAIT_MS,
  force: true,
};

type RegistryFactory = (
  timer: FakeTimer,
  liveness: SlotExecOwnerLiveness,
) => SlotRegistry | Promise<SlotRegistry>;

const REGISTRIES: Array<[string, RegistryFactory]> = [
  ["FakeSlotRegistry", (timer, liveness) => new FakeSlotRegistry(timer, liveness)],
  [
    "SqliteSlotRegistry (:memory:)",
    (timer, liveness) =>
      openSqliteSlotRegistry({ dbPath: ":memory:", timer, isExecOwnerLive: liveness }),
  ],
];

describe.each(REGISTRIES)(
  "reset-slot-scope --force verdicts after the settle wait: %s",
  (_name, open) => {
    let timer: FakeTimer;
    let registry: SlotRegistry;
    let processes: Map<number, string | undefined>;
    let key: SlotKey;
    let reset: SlotScopeReset;
    let warn: ReturnType<typeof spyOn>;
    let releaseCreatedAtMs: number;

    beforeEach(async () => {
      timer = new FakeTimer();
      timer.setCurrentTime(1_000_000);
      timer.enableAutoAdvance();
      processes = new Map([
        [A.pid, A.processGenerationToken ?? undefined],
        [B.pid, B.processGenerationToken ?? undefined],
      ]);
      warn = spyOn(logger, "warn").mockImplementation(() => {});
      // The operator's reset runs through daemon B; daemon A settles the slot.
      const liveness = withLiveExecutionSessions(
        createSlotExecOwnerLiveness({
          isRunning: (pid) => processes.has(pid),
          readGenerationToken: (pid) => processes.get(pid),
        }),
        { isLiveManagedExecutionSession: () => false },
        { thisProcess: { pid: B.pid }, reservations: new InFlightSlotReservations() },
      );
      registry = await open(timer, liveness);
      reset = new SlotScopeReset({
        registry: async () => registry,
        timer,
        isExecOwnerLive: liveness,
        thisProcess: { pid: B.pid },
      });
      const scope = await registry.ensureScope(SCOPE);
      if (scope.kind !== "ready") {
        throw new Error(`scope not ready: ${scope.kind}`);
      }
      key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
      await registry.initSlot(key, { role: "primary", platform: "android", requestedSpec: {} });
      await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: AVD,
          deviceName: AVD,
          resolvedSpec: {},
          specFingerprint: "fp",
          state: "ready",
        },
      );
      // Daemon A's drain marks the slot `settling` with its release journal entry.
      const opened = await registry.openSlotJournal(key, {
        kind: "release",
        phase: "intent",
        owner: A,
        target: {
          oldStableId: AVD,
          oldName: AVD,
          newName: null,
          newStableId: null,
          requestedSpec: {},
          resolvedSpec: {},
          specFingerprint: "fp",
        },
        assignment: {
          kind: "state",
          expected: BINDING,
          state: "settling",
          options: { settler: A },
        },
      });
      if (opened.kind !== "opened") {
        throw new Error(`release entry not opened: ${opened.kind}`);
      }
      releaseCreatedAtMs = opened.entry.createdAtMs;
    });

    afterEach(async () => {
      warn.mockRestore();
      await registry.close();
    });

    test("control: a slot still inside the cap when the command answers is refused with the time left", async () => {
      timer.setCurrentTime(releaseCreatedAtMs + 1_000);

      const result = await reset.reset(RESET);

      expect(result.outcome).toBe("pending");
      // The time left when the command answers, not when it started waiting.
      expect(result.waitedMs).toBe(WAIT_MS);
      expect(result.scopes[0]?.forceRefusals).toEqual([
        expect.objectContaining({
          reason: "within_settlement_cap",
          remainingMs: MANAGED_EXECUTION_SETTLEMENT_CAP_MS - 1_000 - WAIT_MS,
        }),
      ]);
    });

    test("a slot that outlives the cap during the wait is not reported as still inside it", async () => {
      // Two seconds short of the cap; the command then waits ten.
      timer.setCurrentTime(releaseCreatedAtMs + MANAGED_EXECUTION_SETTLEMENT_CAP_MS - 2_000);

      const result = await reset.reset(RESET);

      // The command answered after the cap passed.
      expect(result.waitedMs).toBeGreaterThanOrEqual(WAIT_MS);
      expect(timer.now()).toBeGreaterThan(releaseCreatedAtMs + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);
      // `--force` abandons a settlement past the cap, so either it was applied, or the answer
      // must not claim the slot is inside the cap with time left.
      const stale = (result.scopes[0]?.forceRefusals ?? []).filter(
        (refusal) => refusal.reason === "within_settlement_cap",
      );
      expect(stale).toEqual([]);
      expect(result.outcome).toBe("invalidated");
    });

    test("a settling daemon that exits during the wait is not reported as not known to be gone", async () => {
      timer.setCurrentTime(releaseCreatedAtMs + 1_000);
      // Daemon A exits one second into the command's wait.
      timer.setTimeout(() => processes.delete(A.pid), 1_000);

      const result = await reset.reset(RESET);

      expect(processes.has(A.pid)).toBe(false);
      const stale = (result.scopes[0]?.forceRefusals ?? []).filter(
        (refusal) => refusal.reason === "within_settlement_cap",
      );
      expect(stale).toEqual([]);
    });

    test("a settling daemon that exits during the wait has its slot abandoned and the scope invalidated", async () => {
      timer.setCurrentTime(releaseCreatedAtMs + 1_000);
      timer.setTimeout(() => processes.delete(A.pid), 1_000);

      const result = await reset.reset(RESET);

      expect(result.outcome).toBe("invalidated");
      expect(result.scopes[0]?.forceRefusals).toBeUndefined();
    });

    test("without --force nothing is abandoned after the wait either", async () => {
      timer.setCurrentTime(releaseCreatedAtMs + MANAGED_EXECUTION_SETTLEMENT_CAP_MS - 2_000);

      const result = await reset.reset({ ...RESET, force: false });

      expect(result.outcome).toBe("pending");
      expect(result.scopes[0]?.forceRefusals).toBeUndefined();
      expect(await registry.getAssignment(key)).toMatchObject({ state: "settling" });
    });
  },
);
