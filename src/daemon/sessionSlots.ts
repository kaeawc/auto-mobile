export type SlotTag =
  | "assigning"
  | "creating"
  | "live"
  | "rebinding"
  | "releasing"
  | "ended"
  | "fenced";

export type SlotPhase = SlotTag | "absent";
export type SlotFence = "none" | "terminal";

export const SLOT_TAGS: readonly SlotTag[] = [
  "assigning",
  "creating",
  "live",
  "rebinding",
  "releasing",
  "ended",
  "fenced",
];

/** Payloads stay independent of SessionManager until the legacy maps are migrated. */
export interface SlotPayloads {
  session: unknown;
  assignment: unknown;
  shared: unknown;
  creation: unknown;
  recovery: unknown;
  releaseRequest: unknown;
  rebind: unknown;
  op: unknown;
  snapshot: unknown;
  reason: unknown;
  reservation: unknown;
}

export type SessionSlotState<P extends SlotPayloads = SlotPayloads> =
  | {
      tag: "assigning";
      assignment: P["assignment"];
      shared?: P["shared"];
      releaseRequested?: P["releaseRequest"];
    }
  | {
      tag: "creating";
      creation: P["creation"];
      recovery?: P["recovery"];
      releaseRequested?: P["releaseRequest"];
    }
  | { tag: "live"; session: P["session"] }
  | { tag: "rebinding"; session: P["session"]; rebind: P["rebind"] }
  | {
      tag: "releasing";
      session: P["session"];
      op: P["op"];
      fence: SlotFence;
      rebind?: P["rebind"];
    }
  | {
      tag: "ended";
      // WeakRef requires an object even when the default session payload is unknown.
      identity: WeakRef<P["session"] & object>;
      snapshot: P["snapshot"];
      reason: P["reason"];
      source: "release" | "forced";
    }
  | {
      tag: "fenced";
      identity?: WeakRef<P["session"] & object>;
      snapshot: P["snapshot"];
      reason: P["reason"];
      reservation?: P["reservation"];
      source: "release" | "forced" | "journal" | "peer-journal";
    };

export interface SessionSlot<P extends SlotPayloads = SlotPayloads> {
  readonly uuid: string;
  state: SessionSlotState<P>;
  /** Older incarnations whose release committed but is still finalizing. */
  retiring: ReadonlySet<P["op"]>;
  /** Resolves when the slot next changes tag. */
  settled: Promise<void>;
}

export const LEGAL_SLOT_TRANSITIONS: ReadonlyMap<SlotPhase, ReadonlySet<SlotPhase>> = new Map<
  SlotPhase,
  ReadonlySet<SlotPhase>
>([
  ["absent", new Set<SlotPhase>(["assigning", "creating", "fenced"])],
  ["assigning", new Set<SlotPhase>(["creating", "absent"])],
  ["creating", new Set<SlotPhase>(["absent", "live", "releasing"])],
  ["live", new Set<SlotPhase>(["rebinding", "releasing"])],
  ["rebinding", new Set<SlotPhase>(["live", "releasing"])],
  ["releasing", new Set<SlotPhase>(["ended", "fenced", "live"])],
  ["ended", new Set<SlotPhase>(["creating", "absent"])],
  ["fenced", new Set<SlotPhase>(["creating"])],
]);

export interface SlotPosition {
  tag: SlotPhase;
  fence?: SlotFence;
}

export function checkSlotTransition(
  from: SlotPosition,
  to: SlotPosition,
): { ok: true } | { ok: false; reason: string } {
  const direction = `${from.tag} -> ${to.tag}`;
  if (
    (from.fence !== undefined && from.tag !== "releasing") ||
    (to.fence !== undefined && to.tag !== "releasing")
  ) {
    return { ok: false, reason: `${direction}: fence is only meaningful for releasing` };
  }
  if (from.tag === to.tag) {
    if (from.tag === "releasing" && from.fence === "none" && to.fence === "terminal") {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `${direction}: only the releasing fence upgrade from none to terminal may keep its tag`,
    };
  }
  if (!LEGAL_SLOT_TRANSITIONS.get(from.tag)?.has(to.tag)) {
    return { ok: false, reason: `${direction}: not a legal slot transition` };
  }
  return { ok: true };
}

export class SlotTransitionError extends Error {
  constructor(
    readonly from: SlotPosition,
    readonly to: SlotPosition,
    reason: string,
  ) {
    super(reason);
    this.name = "SlotTransitionError";
  }
}

export function assertSlotTransition(from: SlotPosition, to: SlotPosition): void {
  const result = checkSlotTransition(from, to);
  if (!result.ok) {
    throw new SlotTransitionError(from, to, result.reason);
  }
}

export interface LegacyLifecycleView<S = object> {
  readonly sessions: ReadonlyMap<string, S>;
  readonly pendingAssignments: ReadonlyMap<string, unknown>;
  readonly pendingCreations: ReadonlyMap<string, unknown>;
  readonly pendingReleases: ReadonlyMap<string, unknown>;
  readonly pendingRebinds: ReadonlyMap<string, unknown>;
  readonly releaseOps: ReadonlyMap<
    string,
    { session: S; forced?: boolean; commitDeclined?: boolean }
  >;
  readonly terminalSnapshots: ReadonlyMap<string, unknown>;
  readonly recoveredTerminalIntents: ReadonlyMap<string, unknown>;
  readonly latestFinalizedIdentities: ReadonlyMap<string, { deref(): S | undefined }>;
}

export interface DerivedSlot {
  tag: SlotPhase;
  fence?: SlotFence;
  releaseRequested: boolean;
}

/**
 * First match wins: current non-forced release, published session, creation, assignment,
 * unpublished release op (fenced if terminal, otherwise ended), terminal fence, then a
 * still-reachable finalized identity. A declined commit keeps the published incarnation
 * live; forced/stale ops cannot hide a newer incarnation or pending work. Creation
 * beats an old fence during revival. This mirrors SessionManager's isCurrentSession,
 * isSessionBeingRecreated and getAllKnownSessionIds reads without importing their I/O.
 */
export function deriveSlot<S>(view: LegacyLifecycleView<S>, uuid: string): DerivedSlot {
  const op = view.releaseOps.get(uuid);
  if (op && !op.forced && view.sessions.get(uuid) === op.session && !op.commitDeclined) {
    return {
      tag: "releasing",
      fence: view.terminalSnapshots.has(uuid) ? "terminal" : "none",
      releaseRequested: false,
    };
  }
  if (view.sessions.has(uuid)) {
    return {
      tag: view.pendingRebinds.has(uuid) ? "rebinding" : "live",
      releaseRequested: false,
    };
  }
  if (view.pendingCreations.has(uuid)) {
    return { tag: "creating", releaseRequested: view.pendingReleases.has(uuid) };
  }
  if (view.pendingAssignments.has(uuid)) {
    return { tag: "assigning", releaseRequested: view.pendingReleases.has(uuid) };
  }
  return deriveFinalizedSlot(view, uuid);
}

function deriveFinalizedSlot<S>(view: LegacyLifecycleView<S>, uuid: string): DerivedSlot {
  const fenced = view.terminalSnapshots.has(uuid) || view.recoveredTerminalIntents.has(uuid);
  if (view.releaseOps.has(uuid)) {
    return { tag: fenced ? "fenced" : "ended", releaseRequested: false };
  }
  if (fenced) {
    return { tag: "fenced", releaseRequested: false };
  }
  return {
    tag: view.latestFinalizedIdentities.get(uuid)?.deref() !== undefined ? "ended" : "absent",
    releaseRequested: false,
  };
}

export function deriveSlotTag<S>(view: LegacyLifecycleView<S>, uuid: string): SlotPhase {
  return deriveSlot(view, uuid).tag;
}

export function deriveAllSlots<S>(view: LegacyLifecycleView<S>): Map<string, DerivedSlot> {
  const uuids = new Set([
    ...view.sessions.keys(),
    ...view.pendingAssignments.keys(),
    ...view.pendingCreations.keys(),
    ...view.pendingReleases.keys(),
    ...view.pendingRebinds.keys(),
    ...view.releaseOps.keys(),
    ...view.terminalSnapshots.keys(),
    ...view.recoveredTerminalIntents.keys(),
    ...view.latestFinalizedIdentities.keys(),
  ]);
  const slots = new Map<string, DerivedSlot>();
  for (const uuid of uuids) {
    const slot = deriveSlot(view, uuid);
    if (slot.tag !== "absent") {
      slots.set(uuid, slot);
    }
  }
  return slots;
}

export function isSlotTagBeingRecreated(tag: SlotPhase): boolean {
  return tag === "assigning" || tag === "creating" || tag === "live" || tag === "rebinding";
}

export function isSlotTagKnown(tag: SlotPhase): boolean {
  return tag !== "absent" && tag !== "ended" && tag !== "fenced";
}
