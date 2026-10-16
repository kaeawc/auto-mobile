import { describe, expect, test } from "bun:test";
import {
  LEGAL_SLOT_TRANSITIONS,
  SLOT_TAGS,
  SlotTransitionError,
  assertSlotTransition,
  checkSlotTransition,
  deriveAllSlots,
  deriveSlot,
  deriveSlotTag,
  isSlotTagBeingRecreated,
  isSlotTagKnown,
  type DerivedSlot,
  type LegacyLifecycleView,
  type SessionSlot,
  type SessionSlotState,
  type SlotFence,
  type SlotPayloads,
  type SlotPhase,
  type SlotPosition,
} from "../../src/daemon/sessionSlots";
import { FakeLegacyLifecycleView, deadIdentity } from "../fakes/FakeLegacyLifecycleView";

// Independent oracle from design sections 3.1 and 4, including every absent edge.
const expectedTransitions: Record<SlotPhase, readonly SlotPhase[]> = {
  absent: ["assigning", "creating", "fenced"],
  assigning: ["creating", "absent"],
  creating: ["absent", "live", "releasing"],
  live: ["rebinding", "releasing"],
  rebinding: ["live", "releasing"],
  releasing: ["ended", "fenced", "live"],
  ended: ["creating", "absent"],
  fenced: ["creating"],
};
const phases: readonly SlotPhase[] = [
  "absent",
  "assigning",
  "creating",
  "live",
  "rebinding",
  "releasing",
  "ended",
  "fenced",
];
const phasePairs = phases.flatMap((from) => phases.map((to) => ({ from, to })));

describe("slot transitions", () => {
  test("tags and transition table equal the design exactly", () => {
    expect(SLOT_TAGS).toEqual([
      "assigning",
      "creating",
      "live",
      "rebinding",
      "releasing",
      "ended",
      "fenced",
    ]);
    expect(LEGAL_SLOT_TRANSITIONS).toEqual(
      new Map(phases.map((tag) => [tag, new Set(expectedTransitions[tag])])),
    );
  });

  test.each(phasePairs)("$from -> $to", ({ from, to }) => {
    const start: SlotPosition = { tag: from };
    const end: SlotPosition = { tag: to };
    const result = checkSlotTransition(start, end);
    if (expectedTransitions[from].includes(to)) {
      expect(result).toEqual({ ok: true });
      expect(() => assertSlotTransition(start, end)).not.toThrow();
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(`${from} -> ${to}`);
        expect(result.reason.length).toBeGreaterThan(`${from} -> ${to}: `.length);
        expect(() => assertSlotTransition(start, end)).toThrow(result.reason);
      }
      expect(() => assertSlotTransition(start, end)).toThrow(SlotTransitionError);
      expect(() => assertSlotTransition(start, end)).toThrow(
        expect.objectContaining({ name: "SlotTransitionError", from: start, to: end }),
      );
    }
  });

  const fences: readonly (SlotFence | undefined)[] = [undefined, "none", "terminal"];
  const fencePairs = fences.flatMap((from) => fences.map((to) => ({ from, to })));
  test.each(fencePairs)("releasing fence $from -> $to", ({ from, to }) => {
    const start: SlotPosition = { tag: "releasing", fence: from };
    const end: SlotPosition = { tag: "releasing", fence: to };
    const result = checkSlotTransition(start, end);
    if (from === "none" && to === "terminal") {
      expect(result).toEqual({ ok: true });
      expect(() => assertSlotTransition(start, end)).not.toThrow();
    } else {
      expect(result).toEqual({
        ok: false,
        reason:
          "releasing -> releasing: only the releasing fence upgrade from none to terminal may keep its tag",
      });
      expect(() => assertSlotTransition(start, end)).toThrow(SlotTransitionError);
    }
  });

  test.each(["none", "terminal"] as const)(
    "allows legal tag changes with releasing fence %s",
    (fence) => {
      for (const tag of ["ended", "fenced", "live"] as const) {
        expect(checkSlotTransition({ tag: "releasing", fence }, { tag })).toEqual({ ok: true });
      }
      for (const tag of ["creating", "live", "rebinding"] as const) {
        expect(checkSlotTransition({ tag }, { tag: "releasing", fence })).toEqual({ ok: true });
      }
    },
  );

  test.each(phases.filter((tag) => tag !== "releasing"))(
    "rejects a fence on %s in either position",
    (tag) => {
      for (const fence of ["none", "terminal"] as const) {
        for (const [from, to] of [
          [{ tag, fence }, { tag: "creating" }],
          [{ tag: "releasing" }, { tag, fence }],
        ] satisfies [SlotPosition, SlotPosition][]) {
          expect(checkSlotTransition(from, to)).toEqual({
            ok: false,
            reason: `${from.tag} -> ${to.tag}: fence is only meaningful for releasing`,
          });
        }
      }
    },
  );
});

interface DerivationCase {
  name: string;
  build: (view: FakeLegacyLifecycleView) => FakeLegacyLifecycleView;
  expected: DerivedSlot;
}

const uuid = "session";
const derivationCases: DerivationCase[] = [
  { name: "absent", build: (v) => v, expected: { tag: "absent", releaseRequested: false } },
  {
    name: "assigning",
    build: (v) => v.startAssignment(uuid),
    expected: { tag: "assigning", releaseRequested: false },
  },
  {
    name: "creating",
    build: (v) => v.startCreation(uuid),
    expected: { tag: "creating", releaseRequested: false },
  },
  {
    name: "live",
    build: (v) => v.publish(uuid),
    expected: { tag: "live", releaseRequested: false },
  },
  {
    name: "rebinding",
    build: (v) => v.publish(uuid).startRebind(uuid),
    expected: { tag: "rebinding", releaseRequested: false },
  },
  {
    name: "releasing without a fence (beats published live)",
    build: (v) => v.publish(uuid).startRelease(uuid),
    expected: { tag: "releasing", fence: "none", releaseRequested: false },
  },
  {
    name: "releasing with terminal fence (beats rebinding and creation)",
    build: (v) =>
      v.publish(uuid).startRelease(uuid).fenceTerminal(uuid).startRebind(uuid).startCreation(uuid),
    expected: { tag: "releasing", fence: "terminal", releaseRequested: false },
  },
  {
    name: "ended with reachable identity",
    build: (v) => v.finalize(uuid, { deref: () => ({}) }),
    expected: { tag: "ended", releaseRequested: false },
  },
  {
    name: "fenced by snapshot (beats finalized identity)",
    build: (v) => v.fenceTerminal(uuid).finalize(uuid, { deref: () => ({}) }),
    expected: { tag: "fenced", releaseRequested: false },
  },
  {
    name: "fenced by recovered intent",
    build: (v) => v.recoverIntent(uuid),
    expected: { tag: "fenced", releaseRequested: false },
  },
  {
    name: "dead identity is absent",
    build: (v) => v.finalize(uuid, deadIdentity()),
    expected: { tag: "absent", releaseRequested: false },
  },
  {
    name: "terminal fence survives a dead identity",
    build: (v) => v.finalize(uuid, deadIdentity()).fenceTerminal(uuid),
    expected: { tag: "fenced", releaseRequested: false },
  },
  {
    name: "declined commit remains releasing while a terminal fence is held",
    build: (v) => v.publish(uuid).startRelease(uuid, { commitDeclined: true }).fenceTerminal(uuid),
    expected: { tag: "releasing", fence: "terminal", releaseRequested: false },
  },
  {
    name: "declined commit preserves pending rebind",
    build: (v) => v.publish(uuid).startRelease(uuid, { commitDeclined: true }).startRebind(uuid),
    expected: { tag: "rebinding", releaseRequested: false },
  },
  {
    name: "forced nonterminal release without finalized identity is ended",
    build: (v) => v.publish(uuid).startRelease(uuid, { forced: true }),
    expected: { tag: "ended", releaseRequested: false, residue: true },
  },
  {
    name: "forced terminal release is fenced",
    build: (v) => v.publish(uuid).startRelease(uuid, { forced: true }).fenceTerminal(uuid),
    expected: { tag: "fenced", releaseRequested: false, residue: true },
  },
  {
    name: "forced release with recovered terminal intent is fenced",
    build: (v) => v.publish(uuid).startRelease(uuid, { forced: true }).recoverIntent(uuid),
    expected: { tag: "fenced", releaseRequested: false, residue: true },
  },
  {
    name: "committed release finalizing after session removal is ended",
    build: (v) => v.publish(uuid).startRelease(uuid).unpublish(uuid),
    expected: { tag: "ended", releaseRequested: false, residue: true },
  },
  {
    name: "committed release finalizing outlives an older dead identity",
    build: (v) => v.publish(uuid).startRelease(uuid).unpublish(uuid).finalize(uuid, deadIdentity()),
    expected: { tag: "ended", releaseRequested: false, residue: true },
  },
  {
    name: "new creation beats a forced release and its terminal fence",
    build: (v) =>
      v.publish(uuid).startRelease(uuid, { forced: true }).fenceTerminal(uuid).startCreation(uuid),
    expected: { tag: "creating", releaseRequested: false },
  },
  {
    name: "new creation beats a committed release still finalizing",
    build: (v) => v.publish(uuid).startRelease(uuid).unpublish(uuid).startCreation(uuid),
    expected: { tag: "creating", releaseRequested: false },
  },
  {
    name: "new assignment beats an unpublished release op",
    build: (v) => v.publish(uuid).startRelease(uuid, { forced: true }).startAssignment(uuid),
    expected: { tag: "assigning", releaseRequested: false },
  },
  {
    name: "forced op cannot hide a new live incarnation",
    build: (v) => v.publish(uuid).startRelease(uuid, { forced: true }).publish(uuid),
    expected: { tag: "live", releaseRequested: false },
  },
  {
    name: "stale op cannot hide a new rebinding incarnation",
    build: (v) => v.publish(uuid).startRelease(uuid).publish(uuid).startRebind(uuid),
    expected: { tag: "rebinding", releaseRequested: false },
  },
  {
    name: "unpublished op alone is ended",
    build: (v) => v.startRelease(uuid),
    expected: { tag: "ended", releaseRequested: false, residue: true },
  },
  {
    name: "creating beats assigning and both terminal maps",
    build: (v) =>
      v.startAssignment(uuid).startCreation(uuid).fenceTerminal(uuid).recoverIntent(uuid),
    expected: { tag: "creating", releaseRequested: false },
  },
  {
    name: "assigning beats both terminal maps",
    build: (v) => v.startAssignment(uuid).fenceTerminal(uuid).recoverIntent(uuid),
    expected: { tag: "assigning", releaseRequested: false },
  },
  {
    name: "published session with a terminal fence remains releasing",
    build: (v) => v.publish(uuid).startCreation(uuid).startAssignment(uuid).fenceTerminal(uuid),
    expected: { tag: "releasing", fence: "terminal", releaseRequested: false },
  },
  {
    name: "assigning records release requested",
    build: (v) => v.startAssignment(uuid).requestRelease(uuid),
    expected: { tag: "assigning", releaseRequested: true },
  },
  {
    name: "creating records release requested",
    build: (v) => v.startCreation(uuid).requestRelease(uuid),
    expected: { tag: "creating", releaseRequested: true },
  },
];

describe("legacy slot derivation", () => {
  test.each(derivationCases)("$name", ({ build, expected }) => {
    const view: LegacyLifecycleView = build(new FakeLegacyLifecycleView());
    expect(deriveSlot(view, uuid)).toEqual(expected);
    expect(deriveSlotTag(view, uuid)).toBe(expected.tag);
  });

  test.each(
    derivationCases.filter(({ expected }) => !["assigning", "creating"].includes(expected.tag)),
  )("release request stays false for $name", ({ build, expected }) => {
    const view = build(new FakeLegacyLifecycleView()).requestRelease(uuid);
    expect(deriveSlot(view, uuid)).toEqual(
      ["absent", "ended", "fenced"].includes(expected.tag)
        ? { ...expected, residue: true }
        : expected,
    );
  });

  test("reads presence rather than truthiness for opaque payload maps", () => {
    const view = new FakeLegacyLifecycleView();
    view.pendingCreations.set(uuid, undefined);
    view.pendingReleases.set(uuid, undefined);
    expect(deriveSlot(view, uuid)).toEqual({ tag: "creating", releaseRequested: true });
    view.pendingCreations.delete(uuid);
    view.terminalSnapshots.set(uuid, undefined);
    expect(deriveSlotTag(view, uuid)).toBe("fenced");
  });

  test("deriveAllSlots visits every map's keys, excludes absent and preserves input maps", () => {
    const view = new FakeLegacyLifecycleView()
      .publish("live")
      .startAssignment("assigning")
      .startCreation("creating")
      .requestRelease("creating")
      .requestRelease("orphan-request")
      .startRebind("orphan-rebind")
      .startRelease("orphan-op")
      .fenceTerminal("snapshot")
      .recoverIntent("intent")
      .finalize("ended", { deref: () => ({}) })
      .finalize("dead", deadIdentity())
      .publish("releasing")
      .startRelease("releasing");
    const maps = Object.values(view).filter((value) => value instanceof Map);
    const before = maps.map((map) => new Map(map));
    expect(deriveAllSlots(view)).toEqual(
      new Map<string, DerivedSlot>([
        ["live", { tag: "live", releaseRequested: false }],
        ["assigning", { tag: "assigning", releaseRequested: false }],
        ["creating", { tag: "creating", releaseRequested: true }],
        ["orphan-request", { tag: "absent", releaseRequested: false, residue: true }],
        ["orphan-rebind", { tag: "absent", releaseRequested: false, residue: true }],
        ["orphan-op", { tag: "ended", releaseRequested: false, residue: true }],
        ["snapshot", { tag: "fenced", releaseRequested: false }],
        ["intent", { tag: "fenced", releaseRequested: false }],
        ["ended", { tag: "ended", releaseRequested: false }],
        ["releasing", { tag: "releasing", fence: "none", releaseRequested: false }],
      ]),
    );
    expect(maps).toEqual(before);
  });

  test("deriveAllSlots returns an empty map for an empty view", () => {
    expect(deriveAllSlots(new FakeLegacyLifecycleView())).toEqual(new Map());
  });
});

// Recreation and the occupied-tag part of known membership; S2 adds known residue separately.
const predicateCases: { tag: SlotPhase; recreated: boolean; known: boolean }[] = [
  { tag: "absent", recreated: false, known: false },
  { tag: "assigning", recreated: true, known: true },
  { tag: "creating", recreated: true, known: true },
  { tag: "live", recreated: true, known: true },
  { tag: "rebinding", recreated: true, known: true },
  { tag: "releasing", recreated: true, known: true },
  { tag: "ended", recreated: false, known: false },
  { tag: "fenced", recreated: false, known: false },
];

test.each(predicateCases)("tag predicates for $tag", ({ tag, recreated, known }) => {
  expect(isSlotTagBeingRecreated(tag)).toBe(recreated);
  expect(isSlotTagKnown(tag)).toBe(known);
});

test("generic slot payloads represent every designed state without manager dependencies", () => {
  interface Payloads extends SlotPayloads {
    session: { id: string };
    assignment: Promise<{ id: string }>;
    shared: { shared: boolean };
    creation: { creating: boolean };
    recovery: { recovered: boolean };
    releaseRequest: { requested: boolean };
    rebind: { binding: string };
    op: { releasing: boolean };
    snapshot: { captured: boolean };
    reason: { terminal: boolean };
    reservation: { owner: string };
  }
  const session = { id: uuid };
  const op = { releasing: true };
  const rebind = { binding: "device" };
  const identity = new WeakRef(session);
  const snapshot = { captured: true };
  const reason = { terminal: false };
  const states: SessionSlotState<Payloads>[] = [
    {
      tag: "assigning",
      assignment: Promise.resolve(session),
      shared: { shared: true },
      releaseRequested: { requested: true },
    },
    {
      tag: "creating",
      creation: { creating: true },
      recovery: { recovered: true },
      releaseRequested: { requested: true },
    },
    { tag: "live", session },
    { tag: "rebinding", session, rebind },
    { tag: "releasing", session, op, rebind, fence: "none" },
    { tag: "ended", identity, snapshot, reason, source: "forced" },
    {
      tag: "fenced",
      identity,
      snapshot,
      reason,
      reservation: { owner: uuid },
      source: "peer-journal",
    },
  ];
  const slot: SessionSlot<Payloads> = {
    uuid,
    state: states[0],
    retiring: new Set([op]),
    settled: Promise.resolve(),
  };
  expect(states.map(({ tag }) => tag)).toEqual(SLOT_TAGS);
  expect(slot.uuid).toBe(uuid);
  expect(slot.state).toBe(states[0]);
  expect(slot.retiring.has(op)).toBe(true);
  expect(slot.settled).toBeInstanceOf(Promise);
  expect(identity.deref()).toBe(session);

  const defaultSlot: SessionSlot = {
    uuid,
    state: { tag: "ended", identity, snapshot, reason, source: "release" },
    retiring: new Set(),
    settled: Promise.resolve(),
  };
  expect(defaultSlot.state.tag).toBe("ended");
});
