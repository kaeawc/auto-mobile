import { beforeAll, expect, test } from "bun:test";
import type { Session, SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { deriveSlot, type LegacyLifecycleView } from "../../src/daemon/sessionSlots";
import { assertSlotAgreement, slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";

interface ReleaseOp {
  readonly session: Session;
  readonly promise: Promise<string | null>;
  readonly forced?: boolean;
  readonly commitDeclined?: boolean;
}

interface ReleaseStore {
  readonly releaseOps: ReadonlyMap<string, ReleaseOp>;
  readonly activeReleases: ReadonlySet<ReleaseOp>;
  markReleasing(session: Session): void;
  unmarkReleasing(session: Session): boolean;
  isReleasing(session: Session): boolean;
  getForcedNonTerminal(session: Session): SessionReleaseSnapshot | undefined;
}

beforeAll(async () => {
  const rig = slotAgreementRig();
  await rig.manager.createSession("warm", "fake-warm", "android");
  rig.timer.reset();
});

async function harness(durableJournal = true) {
  const rig = slotAgreementRig(undefined, undefined, undefined, undefined, durableJournal);
  const session = await rig.manager.createSession("id", "fake-id", "android");
  const slots = Reflect.get(rig.manager, "sessionSlots") as ReleaseStore;
  const view: LegacyLifecycleView<Session> = rig.manager.getLegacyLifecycleView();
  const observed: string[] = [];
  const check = (event: string) => {
    observed.push(event);
    expect(view.releaseOps).toBe(slots.releaseOps);
    const ops = [...slots.releaseOps];
    expect(new Set(ops.map(([uuid]) => uuid)).size).toBe(ops.length);
    expect(ops.filter(([uuid]) => uuid === "id").length).toBeLessThanOrEqual(1);
    for (const [uuid, op] of ops) {
      expect(op.session.sessionId).toBe(uuid);
    }
    expect(view.isReleasing(session)).toBe(slots.isReleasing(session));
    const published = view.sessions.get("id");
    const op = slots.releaseOps.get("id");
    const terminal = view.terminalSnapshots.has("id");
    if (published === session) {
      const releasing =
        terminal ||
        slots.isReleasing(session) ||
        (op?.session === session && !op.forced && !op.commitDeclined);
      expect(deriveSlot(view, "id").tag).toBe(releasing ? "releasing" : "live");
      expect(rig.manager.isAdmittedForAutomation(session)).toBe(
        !terminal && !slots.isReleasing(session),
      );
    } else if (slots.isReleasing(session)) {
      // S2: removal precedes continuation cleanup. A retiring identity may still be marked.
      expect([...slots.activeReleases].some((active) => active.session === session)).toBe(true);
    }
    assertSlotAgreement(rig, ["id"], [session], event);
  };
  // Observe the synchronous windows on both sides of releaseSessionInternal, as well as awaits.
  const mark = slots.markReleasing.bind(slots);
  slots.markReleasing = (identity) => {
    mark(identity);
    check("marked-before-op");
  };
  const unmark = slots.unmarkReleasing.bind(slots);
  slots.unmarkReleasing = (identity) => {
    const removed = unmark(identity);
    check("unmarked-before-op-cleanup");
    return removed;
  };
  const turns = async () => {
    for (let turn = 0; turn < 80; turn++) {
      await Promise.resolve();
      check("microtask");
    }
  };
  const settled = () => {
    check("settled");
    expect(slots.releaseOps.has("id")).toBe(false);
    expect(slots.isReleasing(session)).toBe(false);
    expect([...slots.activeReleases].some((op) => op.session === session)).toBe(false);
    expect(observed).toContain("marked-before-op");
    expect(observed).toContain("unmarked-before-op-cleanup");
    expect(rig.timer.getSleepHistory()).toEqual([]);
    rig.timer.reset();
  };
  return { ...rig, session, slots, view, check, turns, settled };
}

test("joined releases publish one op and clear both facets after settling", async () => {
  const h = await harness();
  const hold = Promise.withResolvers<"teardown">();
  let holds = 0;
  h.manager.setReleaseDeviceHold(() => {
    holds++;
    return { settled: hold.promise, capMs: 10_000 };
  });
  const release = h.manager.releaseSession("id", "plan-auto-release");
  const op = h.slots.releaseOps.get("id")!;
  const storedPromise = op.promise;
  const joined = h.manager.releaseSession("id", "plan-auto-release");
  h.check("joined");
  expect(holds).toBe(1);
  expect(h.slots.releaseOps.size).toBe(1);
  expect(h.slots.activeReleases.size).toBe(1);
  expect(h.slots.releaseOps.get("id")).toBe(op);
  expect(op.promise).toBe(storedPromise);
  expect(h.slots.isReleasing(h.session)).toBe(true);
  await h.turns();
  hold.resolve("teardown");
  await h.turns();
  expect(await release).toBe("fake-id");
  expect(await joined).toBe("fake-id");
  h.settled();
});

test.each(["plan-auto-release", "explicit-release"])(
  "forcing parked %s preserves residue until its continuation settles",
  async (reason) => {
    const h = await harness();
    const hold = Promise.withResolvers<"teardown">();
    h.manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 10_000 }));
    const release = h.manager.releaseSession("id", reason);
    const op = h.slots.releaseOps.get("id")!;
    expect(h.manager.forceStuckRelease("id")?.stage).toBe("awaiting-ownership");
    h.check("forced");
    expect(op.forced).toBe(true);
    expect(h.view.sessions.has("id")).toBe(false);
    expect(h.slots.activeReleases.has(op)).toBe(true);
    expect(h.slots.releaseOps.get("id")).toBe(op);
    expect(deriveSlot(h.view, "id").residue).toBe(true);
    expect(h.manager.getAllKnownSessionIds()).toContain("id");
    expect(h.slots.getForcedNonTerminal(h.session)?.releaseReason).toBe(
      reason === "plan-auto-release" ? reason : undefined,
    );
    await h.turns();
    hold.resolve("teardown");
    await h.turns();
    expect(await release).toBeNull();
    h.settled();
  },
);

test("declined release restores admission and clears the op and releasing mark", async () => {
  const h = await harness();
  const release = h.manager.releaseSessionUnlessSuperseded("id", "device-disconnected:fake", {
    commitFence: () => false,
  });
  h.check("declining");
  await h.turns();
  expect((await release).superseded).toBe(true);
  expect(h.view.sessions.get("id")).toBe(h.session);
  expect(h.manager.isAdmittedForAutomation(h.session)).toBe(true);
  h.settled();
});

// Write-first order (a volatile journal): a failed row leaves the session published and fenced.
test("a failed terminal write leaves a published fence after op and mark cleanup", async () => {
  const h = await harness(false);
  h.persistence.failure = "release";
  const release = h.manager.releaseSession("id", "explicit-release");
  const failure = expect(release).rejects.toThrow();
  await h.turns();
  await failure;
  expect(h.view.sessions.get("id")).toBe(h.session);
  expect(h.view.terminalSnapshots.has("id")).toBe(true);
  expect(deriveSlot(h.view, "id")).toEqual({
    tag: "releasing",
    fence: "terminal",
    releaseRequested: false,
  });
  h.settled();
});
