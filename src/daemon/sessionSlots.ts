/** Assignment and creation facets retain the legacy maps' identity and insertion order. */
export class SessionSlots<A, Sh, C, R extends object, Rel> {
  /** Automatic device assignments that have not yet started their creation write. */
  private readonly pendingSessionAssignments = new Map<string, A>();
  private readonly sharedSessionAssignments = new Map<string, Sh>();
  /** Creation writes that must finish before a session becomes visible to callers. */
  private readonly pendingSessionCreations = new Map<string, C>();
  /** Persisted recovery state consumed by createSession before it publishes an assigned session. */
  private readonly pendingPersistedRecoveries = new Map<string, R>();
  /** Rows this daemon claimed for recovery (#11200); their upsert is conditioned on the claim. */
  private readonly claimedRecoverableRows = new WeakSet<R>();
  /** Releases received before an assignment has published its session. */
  private readonly pendingSessionReleases = new Map<string, Rel>();

  get assignments(): ReadonlyMap<string, A> {
    return this.pendingSessionAssignments;
  }

  getAssignment(id: string): A | undefined {
    return this.pendingSessionAssignments.get(id);
  }

  hasAssignment(id: string): boolean {
    return this.pendingSessionAssignments.has(id);
  }

  setAssignment(id: string, value: A): void {
    this.pendingSessionAssignments.set(id, value);
  }

  deleteAssignment(id: string): boolean {
    return this.pendingSessionAssignments.delete(id);
  }

  get sharedAssignments(): ReadonlyMap<string, Sh> {
    return this.sharedSessionAssignments;
  }

  getShared(id: string): Sh | undefined {
    return this.sharedSessionAssignments.get(id);
  }

  setShared(id: string, value: Sh): void {
    this.sharedSessionAssignments.set(id, value);
  }

  deleteShared(id: string): boolean {
    return this.sharedSessionAssignments.delete(id);
  }

  get creations(): ReadonlyMap<string, C> {
    return this.pendingSessionCreations;
  }

  getCreation(id: string): C | undefined {
    return this.pendingSessionCreations.get(id);
  }

  hasCreation(id: string): boolean {
    return this.pendingSessionCreations.has(id);
  }

  setCreation(id: string, value: C): void {
    this.pendingSessionCreations.set(id, value);
  }

  deleteCreation(id: string): boolean {
    return this.pendingSessionCreations.delete(id);
  }

  get recoveries(): ReadonlyMap<string, R> {
    return this.pendingPersistedRecoveries;
  }

  getRecovery(id: string): R | undefined {
    return this.pendingPersistedRecoveries.get(id);
  }

  hasRecovery(id: string): boolean {
    return this.pendingPersistedRecoveries.has(id);
  }

  setRecovery(id: string, value: R): void {
    this.pendingPersistedRecoveries.set(id, value);
  }

  deleteRecovery(id: string): boolean {
    return this.pendingPersistedRecoveries.delete(id);
  }

  get releaseRequests(): ReadonlyMap<string, Rel> {
    return this.pendingSessionReleases;
  }

  getReleaseRequest(id: string): Rel | undefined {
    return this.pendingSessionReleases.get(id);
  }

  setReleaseRequest(id: string, value: Rel): void {
    this.pendingSessionReleases.set(id, value);
  }

  deleteReleaseRequest(id: string): boolean {
    return this.pendingSessionReleases.delete(id);
  }

  markRowClaimed(row: R): void {
    this.claimedRecoverableRows.add(row);
  }

  isRowClaimed(row: R): boolean {
    return this.claimedRecoverableRows.has(row);
  }
}

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
  isReleasing(session: S): boolean;
  readonly pendingAssignments: ReadonlyMap<string, unknown>;
  readonly pendingCreations: ReadonlyMap<string, unknown>;
  readonly pendingReleases: ReadonlyMap<string, unknown>;
  readonly pendingRebinds: ReadonlyMap<string, unknown>;
  readonly releaseOps: ReadonlyMap<
    string,
    { readonly session: S; readonly forced?: boolean; readonly commitDeclined?: boolean }
  >;
  readonly terminalSnapshots: ReadonlyMap<string, unknown>;
  readonly recoveredTerminalIntents: ReadonlyMap<string, unknown>;
  readonly latestFinalizedIdentities: ReadonlyMap<string, { deref(): S | undefined }>;
}

export interface DerivedSlot {
  tag: SlotPhase;
  fence?: SlotFence;
  releaseRequested: boolean;
  /** Legacy pending work still counts as known after its session has disappeared. */
  residue?: true;
}

/** Published incarnations outrank old operations; terminal fences also cover declined commits. */
export function deriveSlot<S>(view: LegacyLifecycleView<S>, uuid: string): DerivedSlot {
  const session = view.sessions.get(uuid);
  if (session !== undefined) {
    return derivePublishedSlot(view, uuid, session);
  }
  if (view.pendingCreations.has(uuid)) {
    return { tag: "creating", releaseRequested: view.pendingReleases.has(uuid) };
  }
  if (view.pendingAssignments.has(uuid)) {
    return { tag: "assigning", releaseRequested: view.pendingReleases.has(uuid) };
  }
  const slot = deriveFinalizedSlot(view, uuid);
  if (
    view.pendingReleases.has(uuid) ||
    view.pendingRebinds.has(uuid) ||
    view.releaseOps.has(uuid)
  ) {
    slot.residue = true;
  }
  return slot;
}

function derivePublishedSlot<S>(
  view: LegacyLifecycleView<S>,
  uuid: string,
  session: S,
): DerivedSlot {
  const op = view.releaseOps.get(uuid);
  const terminal = view.terminalSnapshots.has(uuid);
  if (
    terminal ||
    view.isReleasing(session) ||
    (op?.session === session && !op.forced && !op.commitDeclined)
  ) {
    return { tag: "releasing", fence: terminal ? "terminal" : "none", releaseRequested: false };
  }
  return { tag: view.pendingRebinds.has(uuid) ? "rebinding" : "live", releaseRequested: false };
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
    if (slot.tag !== "absent" || slot.residue) {
      slots.set(uuid, slot);
    }
  }
  return slots;
}

export function isSlotTagBeingRecreated(tag: SlotPhase): boolean {
  return (
    tag === "assigning" ||
    tag === "creating" ||
    tag === "live" ||
    tag === "rebinding" ||
    tag === "releasing"
  );
}

export function isSlotTagKnown(tag: SlotPhase): boolean {
  return tag !== "absent" && tag !== "ended" && tag !== "fenced";
}

/** During migration a finalized/absent slot can still have legacy work awaiting cleanup. */
export function isSlotKnown(slot: DerivedSlot): boolean {
  return isSlotTagKnown(slot.tag) || slot.residue === true;
}

/** Constant-time equivalent of getAllKnownSessionIds membership, without allocating its union. */
export function isLegacySessionIdKnown<S>(view: LegacyLifecycleView<S>, uuid: string): boolean {
  return (
    view.sessions.has(uuid) ||
    view.pendingCreations.has(uuid) ||
    view.pendingAssignments.has(uuid) ||
    view.pendingRebinds.has(uuid) ||
    view.pendingReleases.has(uuid) ||
    view.releaseOps.has(uuid)
  );
}

/** Identity read for the shadow model, including unpublished and finalized incarnations. */
export function deriveLatestSessionIdentity<S>(
  view: LegacyLifecycleView<S>,
  uuid: string,
): S | undefined {
  const published = view.sessions.get(uuid);
  if (published !== undefined) {
    return published;
  }
  if (view.pendingCreations.has(uuid) || view.pendingAssignments.has(uuid)) {
    return undefined;
  }
  return view.releaseOps.get(uuid)?.session ?? view.latestFinalizedIdentities.get(uuid)?.deref();
}
