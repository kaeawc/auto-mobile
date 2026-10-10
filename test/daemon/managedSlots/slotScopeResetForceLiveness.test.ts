import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { openSqliteSlotRegistry } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { MANAGED_EXECUTION_SETTLEMENT_CAP_MS } from "../../../src/daemon/managedSlots/managedExecutionRelease";
import { SlotScopeReset } from "../../../src/daemon/managedSlots/slotScopeReset";
import { logger } from "../../../src/utils/logger";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// #11545 follow-ups: `reset-slot-scope --force` judged by owner and settler liveness when two
// daemons share the host-wide registry. Daemon A settles a slot; the operator's reset may run
// through A or through a second daemon B. Liveness is the daemon's own wiring
// (`withLiveExecutionSessions` over the PID-plus-start-identity predicate), with a fake process
// table, so a dead process, a reused PID and a session held by another daemon are all real inputs.

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
const S1 = "session-1";
const AVD = "amslot-test-0-g1";
const BINDING = { generation: 1, stableDeviceId: AVD };
const SCOPE = {
  managedHostScope: "host",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const RESET = {
  runnerNamespace: SCOPE.runnerNamespace,
  runnerIncarnation: SCOPE.runnerIncarnation,
  waitMs: 0,
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

describe.each(REGISTRIES)("reset-slot-scope --force liveness (#11545): %s", (_name, open) => {
  let timer: FakeTimer;
  let registry: SlotRegistry;
  /** Running processes: PID to its current process-generation token. */
  let processes: Map<number, string | undefined>;
  /** Sessions the daemon running the reset holds as live managed executions. */
  let heldHere: Set<string>;
  let key: SlotKey;
  let reset: SlotScopeReset;
  let warn: ReturnType<typeof spyOn>;

  /** Open the registry as daemon `self` sees it, with one bound, ready slot. */
  async function openAs(self: SlotProcessIdentity): Promise<void> {
    const liveness = withLiveExecutionSessions(
      createSlotExecOwnerLiveness({
        isRunning: (pid) => processes.has(pid),
        readGenerationToken: (pid) => processes.get(pid),
      }),
      { isLiveManagedExecutionSession: (sessionUuid) => heldHere.has(sessionUuid) },
      { thisProcess: { pid: self.pid }, reservations: new InFlightSlotReservations() },
    );
    registry = await open(timer, liveness);
    reset = new SlotScopeReset({
      registry: async () => registry,
      timer,
      isExecOwnerLive: liveness,
      thisProcess: { pid: self.pid },
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
  }

  /** Daemon A's execution S1 claims the slot. */
  async function claimByA(): Promise<void> {
    const claimed = await registry.claimExecution(key, BINDING, { ...A, sessionUuid: S1 });
    expect(claimed.kind).toBe("claimed");
  }

  /** Daemon A's drain marks the slot `settling`, journaled or not, as its settler. */
  async function markSettlingByA(
    journaled = true,
    settler: SlotProcessIdentity = A,
  ): Promise<void> {
    if (!journaled) {
      const updated = await registry.updateSlotState(key, BINDING, "settling", { settler });
      expect(updated.kind).toBe("updated");
      return;
    }
    const opened = await registry.openSlotJournal(key, {
      kind: "release",
      phase: "intent",
      owner: settler,
      target: {
        oldStableId: AVD,
        oldName: AVD,
        newName: null,
        newStableId: null,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
      },
      assignment: { kind: "state", expected: BINDING, state: "settling", options: { settler } },
    });
    expect(opened.kind).toBe("opened");
  }

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    timer.enableAutoAdvance();
    processes = new Map([
      [A.pid, A.processGenerationToken ?? undefined],
      [B.pid, B.processGenerationToken ?? undefined],
    ]);
    heldHere = new Set();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await registry.close();
  });

  describe("a slot --force leaves alone for its owner always says why", () => {
    test("another running daemon's owner record: its session liveness cannot be known from here", async () => {
      await openAs(B);
      // A's execution ended but its owner clear failed; A itself keeps running.
      await claimByA();
      await markSettlingByA();
      timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);

      const forced = await reset.reset(RESET);

      expect(forced.outcome).toBe("pending");
      expect(forced.scopes[0]?.pending?.liveOwners).toEqual([
        { slotIndex: 0, sessionUuid: S1, pid: A.pid },
      ]);
      expect(forced.scopes[0]?.forceRefusals).toEqual([
        {
          slotIndex: 0,
          reason: "owner_liveness_unknown",
          message: expect.stringContaining(`pid ${A.pid}`),
        },
      ]);
      expect(forced.scopes[0]?.forceRefusals?.[0]?.message).toContain(S1);
      // Never guessed dead: the slot and its release entry are untouched.
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "settling",
        execOwner: { sessionUuid: S1 },
      });
      expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);
    });

    test("this daemon's own live execution: in use", async () => {
      await openAs(A);
      await claimByA();
      await markSettlingByA();
      heldHere.add(S1);
      timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);

      const forced = await reset.reset(RESET);

      expect(forced.outcome).toBe("pending");
      expect(forced.scopes[0]?.forceRefusals).toEqual([
        { slotIndex: 0, reason: "live_owner", message: expect.stringContaining(S1) },
      ]);
      expect((await registry.getAssignment(key))?.state).toBe("settling");
    });

    test("a ready slot in use by a live execution is reported too", async () => {
      await openAs(A);
      await claimByA();
      heldHere.add(S1);

      const forced = await reset.reset(RESET);

      expect(forced.outcome).toBe("pending");
      expect(forced.scopes[0]?.forceRefusals?.map((refusal) => refusal.reason)).toEqual([
        "live_owner",
      ]);
    });

    test("the settling daemon itself judges its ended session dead and abandons past the cap", async () => {
      await openAs(A);
      await claimByA();
      await markSettlingByA();
      timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);

      const forced = await reset.reset(RESET);

      expect(forced.outcome).toBe("invalidated");
      expect(forced.scopes[0]?.forceRefusals).toBeUndefined();
    });

    test("a dead daemon's owner record is dead from any daemon", async () => {
      await openAs(B);
      await claimByA();
      await markSettlingByA();
      processes.delete(A.pid);
      timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);

      expect((await reset.reset(RESET)).outcome).toBe("invalidated");
    });
  });

  describe("--force inside the settlement cap consults settler liveness", () => {
    const WITHIN_CAP = {
      slotIndex: 0,
      reason: "within_settlement_cap",
      remainingMs: MANAGED_EXECUTION_SETTLEMENT_CAP_MS - 500,
      message: expect.stringContaining("retry --force"),
    };

    async function forceInsideCap() {
      timer.setCurrentTime(timer.now() + 500);
      return reset.reset(RESET);
    }

    test("a slot whose settling daemon is dead is abandoned at once", async () => {
      await openAs(B);
      await markSettlingByA();
      processes.delete(A.pid);

      const forced = await forceInsideCap();

      expect(forced.outcome).toBe("invalidated");
      expect(forced.scopes[0]?.freedDevices).toEqual([
        { platform: "android", stableDeviceId: AVD },
      ]);
      expect(await registry.listOpenSlotJournal()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("settling daemon is gone"));
    });

    test("a dead daemon's leftover owner record does not hold it either", async () => {
      await openAs(B);
      await claimByA();
      await markSettlingByA();
      processes.delete(A.pid);

      expect((await forceInsideCap()).outcome).toBe("invalidated");
    });

    test("a slot whose settler is running is still refused, with its settler named", async () => {
      await openAs(B);
      await markSettlingByA();

      const forced = await forceInsideCap();

      expect(forced.outcome).toBe("pending");
      expect(forced.scopes[0]?.forceRefusals).toEqual([WITHIN_CAP]);
      expect(forced.scopes[0]?.forceRefusals?.[0]?.message).toContain(`pid ${A.pid}`);
      expect((await registry.getAssignment(key))?.state).toBe("settling");
      expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);
    });

    test("the settling daemon's own reset is refused: its work may be running", async () => {
      await openAs(A);
      await markSettlingByA();

      expect((await forceInsideCap()).scopes[0]?.forceRefusals).toEqual([WITHIN_CAP]);
    });

    test("a settler PID reused by another process is dead (start identity differs)", async () => {
      await openAs(B);
      await markSettlingByA();
      processes.set(A.pid, "linux:boot:999");

      expect((await forceInsideCap()).outcome).toBe("invalidated");
    });

    test("a running settler PID that cannot be proven reused is not guessed dead", async () => {
      await openAs(B);
      // Recorded without a start identity: a reused PID cannot be told from the settler.
      await markSettlingByA(true, { daemonId: A.daemonId, pid: A.pid });
      processes.set(A.pid, "linux:boot:999");

      expect((await forceInsideCap()).scopes[0]?.forceRefusals).toEqual([WITHIN_CAP]);
      expect((await registry.getAssignment(key))?.state).toBe("settling");
    });

    test("a dead settler never cuts an execution this daemon holds", async () => {
      await openAs(B);
      await claimByA();
      await markSettlingByA();
      // A restarted as B: the record still names dead A, and B holds the execution (#11275).
      processes.delete(A.pid);
      heldHere.add(S1);

      const forced = await forceInsideCap();

      expect(forced.outcome).toBe("pending");
      expect(forced.scopes[0]?.forceRefusals?.map((refusal) => refusal.reason)).toEqual([
        "live_owner",
      ]);
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "settling",
        execOwner: { sessionUuid: S1 },
      });
      expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);
    });

    test("a release entry a running daemon took over is not abandoned under it", async () => {
      await openAs(B);
      await markSettlingByA();
      processes.delete(A.pid);
      const C: SlotProcessIdentity = {
        daemonId: "daemon-c",
        pid: 6161,
        processGenerationToken: "linux:boot:300",
      };
      processes.set(C.pid, C.processGenerationToken ?? undefined);
      const [entry] = await registry.listOpenSlotJournal(key);
      expect((await registry.claimSlotJournal(entry!.id, A, C)).kind).toBe("claimed");

      const forced = await forceInsideCap();

      expect(forced.scopes[0]?.forceRefusals).toEqual([WITHIN_CAP]);
      expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);
    });
  });

  test("a settling slot with no release entry names the path that works: restart its settler", async () => {
    await openAs(B);
    await markSettlingByA(false);
    timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);

    const forced = await reset.reset(RESET);

    expect(forced.outcome).toBe("pending");
    expect(forced.scopes[0]?.forceRefusals).toEqual([
      {
        slotIndex: 0,
        reason: "no_release_entry",
        message: expect.stringMatching(/[Rr]estart/),
      },
    ]);
    const message = forced.scopes[0]?.forceRefusals?.[0]?.message ?? "";
    expect(message).toContain(`${A.daemonId} (pid ${A.pid})`);
    expect(message).not.toContain("inspect it");
    expect((await registry.getAssignment(key))?.state).toBe("settling");
  });
});
