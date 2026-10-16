/** Registration seam lets tests deliver cleanup without relying on real garbage collection. */
export interface FinalizationRegistryLike<T> {
  register(target: object, held: T): void;
}

/** Lifecycle facets retain the legacy maps' identity and insertion order. */
export class SessionSlots<
  A,
  Sh,
  C,
  R extends object,
  Rel,
  Reb,
  Cleanup,
  Op,
  Snapshot,
  S extends object,
  TerminalSnapshot = Snapshot,
  Reason = unknown,
  Reservation = unknown,
  Intent = unknown,
> {
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

  /** Rebinds that a release must await before it can remove the live binding. */
  private readonly pendingRebinds = new Map<string, Reb>();
  private readonly deferredCleanupOwners = new Map<
    Cleanup,
    { sessionId: string; deviceId: string }
  >();

  private readonly releasePromises = new Map<string, Op>();
  /** Every release still running, including an older session that reused a UUID. */
  private readonly activeReleasePromises = new Set<Op>();
  /** Forced non-terminal snapshots belong to the exact incarnation, even if teardown stays stuck. */
  private readonly forcedNonTerminalReleases = new WeakMap<S, Snapshot>();
  /** Sessions whose teardown has closed admission for further device-state setup. */
  private readonly releasingSessions = new WeakSet<S>();

  private readonly terminalReleaseSnapshots = new Map<string, TerminalSnapshot>();
  /** Finalized terminal state used to coalesce UUID-only recovery retries. */
  private readonly terminalReleaseReasonStates = new Map<string, Reason>();
  /** UUID admission fences held while a device shutdown decides its terminal outcome. */
  private readonly terminalReleaseReservations = new Map<string, Reservation>();
  /** Latest finalized incarnation, weakly retained until a same-UUID replacement publishes. */
  private readonly latestFinalizedSessionIdentities = new Map<string, WeakRef<S>>();
  private readonly finalizedSessionIdentityRegistry: FinalizationRegistryLike<{
    sessionId: string;
    identity: WeakRef<S>;
  }>;
  /** Recovered intents fence UUIDs until their terminal row writes land. */
  private readonly recoveredTerminalReleaseIntents = new Map<string, Intent>();
  /** Dead peer journals are read only once after startup (#11355). */
  private readonly adoptedDeadDaemonJournals = new Set<string>();
  /** An adopted intent applies only while its row still belongs to this dead daemon. */
  private readonly adoptedTerminalReleaseOwners = new Map<string, string>();

  private readonly tagWaiters = new Map<
    string,
    {
      view: LegacyLifecycleView<S>;
      tag: SlotPhase;
      promise: Promise<void>;
      resolve: () => void;
    }
  >();

  /** Shared, resolve-only notification for the next tag change, with no promise wrapper. */
  settled(id: string, view: LegacyLifecycleView<S>): Promise<void> {
    const existing = this.tagWaiters.get(id);
    if (existing) {
      return existing.promise;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.tagWaiters.set(id, { view, tag: deriveSlotTag(view, id), promise, resolve });
    return promise;
  }

  /** Also called at publication/unpublication, whose session map still belongs to the manager. */
  notifySettled(id: string): void {
    const waiter = this.tagWaiters.get(id);
    if (waiter && deriveSlotTag(waiter.view, id) !== waiter.tag) {
      this.tagWaiters.delete(id);
      waiter.resolve();
    }
  }

  private notifyReleasingChanged(): void {
    for (const id of this.tagWaiters.keys()) {
      this.notifySettled(id);
    }
  }

  constructor(
    options: {
      onFinalizedIdentityCollected?: (id: string) => void;
      createFinalizationRegistry?: (
        cleanup: (held: { sessionId: string; identity: WeakRef<S> }) => void,
      ) => FinalizationRegistryLike<{ sessionId: string; identity: WeakRef<S> }>;
    } = {},
  ) {
    const cleanup = ({ sessionId, identity }: { sessionId: string; identity: WeakRef<S> }) => {
      if (this.latestFinalizedSessionIdentities.get(sessionId) === identity) {
        this.latestFinalizedSessionIdentities.delete(sessionId);
        this.notifySettled(sessionId);
        options.onFinalizedIdentityCollected?.(sessionId);
      }
    };
    this.finalizedSessionIdentityRegistry = options.createFinalizationRegistry
      ? options.createFinalizationRegistry(cleanup)
      : new FinalizationRegistry(cleanup);
  }

  recordFinalizedIdentity(session: S & { sessionId: string }): void {
    const existingIdentity = this.latestFinalizedSessionIdentities.get(session.sessionId);
    if (existingIdentity?.deref() === session) {
      return;
    }
    const identity = new WeakRef(session);
    this.latestFinalizedSessionIdentities.set(session.sessionId, identity);
    this.notifySettled(session.sessionId);
    this.finalizedSessionIdentityRegistry.register(session, {
      sessionId: session.sessionId,
      identity,
    });
  }

  get terminalSnapshots(): ReadonlyMap<string, TerminalSnapshot> {
    return this.terminalReleaseSnapshots;
  }

  getTerminalSnapshot(id: string): TerminalSnapshot | undefined {
    return this.terminalReleaseSnapshots.get(id);
  }

  hasTerminalSnapshot(id: string): boolean {
    return this.terminalReleaseSnapshots.has(id);
  }

  setTerminalSnapshot(id: string, value: TerminalSnapshot): void {
    this.terminalReleaseSnapshots.set(id, value);
    this.notifySettled(id);
  }

  deleteTerminalSnapshot(id: string): boolean {
    const deleted = this.terminalReleaseSnapshots.delete(id);
    this.notifySettled(id);
    return deleted;
  }

  get terminalReasonStates(): ReadonlyMap<string, Reason> {
    return this.terminalReleaseReasonStates;
  }

  getTerminalReasonState(id: string): Reason | undefined {
    return this.terminalReleaseReasonStates.get(id);
  }

  hasTerminalReasonState(id: string): boolean {
    return this.terminalReleaseReasonStates.has(id);
  }

  setTerminalReasonState(id: string, value: Reason): void {
    this.terminalReleaseReasonStates.set(id, value);
  }

  deleteTerminalReasonState(id: string): boolean {
    return this.terminalReleaseReasonStates.delete(id);
  }

  get terminalReservations(): ReadonlyMap<string, Reservation> {
    return this.terminalReleaseReservations;
  }

  getTerminalReservation(id: string): Reservation | undefined {
    return this.terminalReleaseReservations.get(id);
  }

  hasTerminalReservation(id: string): boolean {
    return this.terminalReleaseReservations.has(id);
  }

  setTerminalReservation(id: string, value: Reservation): void {
    this.terminalReleaseReservations.set(id, value);
  }

  deleteTerminalReservation(id: string): boolean {
    return this.terminalReleaseReservations.delete(id);
  }

  get latestFinalizedIdentities(): ReadonlyMap<string, WeakRef<S>> {
    return this.latestFinalizedSessionIdentities;
  }

  getFinalizedIdentity(id: string): WeakRef<S> | undefined {
    return this.latestFinalizedSessionIdentities.get(id);
  }

  hasFinalizedIdentity(id: string): boolean {
    return this.latestFinalizedSessionIdentities.has(id);
  }

  deleteFinalizedIdentity(id: string): boolean {
    const deleted = this.latestFinalizedSessionIdentities.delete(id);
    this.notifySettled(id);
    return deleted;
  }

  get recoveredTerminalIntents(): ReadonlyMap<string, Intent> {
    return this.recoveredTerminalReleaseIntents;
  }

  getRecoveredTerminalIntent(id: string): Intent | undefined {
    return this.recoveredTerminalReleaseIntents.get(id);
  }

  hasRecoveredTerminalIntent(id: string): boolean {
    return this.recoveredTerminalReleaseIntents.has(id);
  }

  setRecoveredTerminalIntent(id: string, value: Intent): void {
    this.recoveredTerminalReleaseIntents.set(id, value);
    this.notifySettled(id);
  }

  deleteRecoveredTerminalIntent(id: string): boolean {
    const deleted = this.recoveredTerminalReleaseIntents.delete(id);
    this.notifySettled(id);
    return deleted;
  }

  get adoptedTerminalOwners(): ReadonlyMap<string, string> {
    return this.adoptedTerminalReleaseOwners;
  }

  getAdoptedTerminalOwner(id: string): string | undefined {
    return this.adoptedTerminalReleaseOwners.get(id);
  }

  hasAdoptedTerminalOwner(id: string): boolean {
    return this.adoptedTerminalReleaseOwners.has(id);
  }

  setAdoptedTerminalOwner(id: string, value: string): void {
    this.adoptedTerminalReleaseOwners.set(id, value);
  }

  deleteAdoptedTerminalOwner(id: string): boolean {
    return this.adoptedTerminalReleaseOwners.delete(id);
  }

  get adoptedDeadJournals(): ReadonlySet<string> {
    return this.adoptedDeadDaemonJournals;
  }

  hasAdoptedDeadJournal(owner: string): boolean {
    return this.adoptedDeadDaemonJournals.has(owner);
  }

  addAdoptedDeadJournal(owner: string): void {
    this.adoptedDeadDaemonJournals.add(owner);
  }

  deleteAdoptedDeadJournal(owner: string): boolean {
    return this.adoptedDeadDaemonJournals.delete(owner);
  }

  get releaseOps(): ReadonlyMap<string, Op> {
    return this.releasePromises;
  }

  getReleaseOp(id: string): Op | undefined {
    return this.releasePromises.get(id);
  }

  hasReleaseOp(id: string): boolean {
    return this.releasePromises.has(id);
  }

  setReleaseOp(id: string, value: Op): void {
    this.releasePromises.set(id, value);
    this.notifySettled(id);
  }

  deleteReleaseOp(id: string): boolean {
    const deleted = this.releasePromises.delete(id);
    this.notifySettled(id);
    return deleted;
  }

  get activeReleases(): ReadonlySet<Op> {
    return this.activeReleasePromises;
  }

  addActiveRelease(op: Op): void {
    this.activeReleasePromises.add(op);
  }

  hasActiveRelease(op: Op): boolean {
    return this.activeReleasePromises.has(op);
  }

  deleteActiveRelease(op: Op): boolean {
    return this.activeReleasePromises.delete(op);
  }

  markReleasing(session: S): void {
    this.releasingSessions.add(session);
    this.notifyReleasingChanged();
  }

  unmarkReleasing(session: S): boolean {
    const deleted = this.releasingSessions.delete(session);
    this.notifyReleasingChanged();
    return deleted;
  }

  isReleasing(session: S): boolean {
    return this.releasingSessions.has(session);
  }

  getForcedNonTerminal(session: S): Snapshot | undefined {
    return this.forcedNonTerminalReleases.get(session);
  }

  setForcedNonTerminal(session: S, snapshot: Snapshot): void {
    this.forcedNonTerminalReleases.set(session, snapshot);
  }

  hasForcedNonTerminal(session: S): boolean {
    return this.forcedNonTerminalReleases.has(session);
  }

  deleteForcedNonTerminal(session: S): boolean {
    return this.forcedNonTerminalReleases.delete(session);
  }

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
    this.notifySettled(id);
  }

  deleteAssignment(id: string): boolean {
    const deleted = this.pendingSessionAssignments.delete(id);
    this.notifySettled(id);
    return deleted;
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
    this.notifySettled(id);
  }

  deleteCreation(id: string): boolean {
    const deleted = this.pendingSessionCreations.delete(id);
    this.notifySettled(id);
    return deleted;
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
    this.notifySettled(id);
  }

  deleteReleaseRequest(id: string): boolean {
    const deleted = this.pendingSessionReleases.delete(id);
    this.notifySettled(id);
    return deleted;
  }

  get rebinds(): ReadonlyMap<string, Reb> {
    return this.pendingRebinds;
  }

  getRebind(id: string): Reb | undefined {
    return this.pendingRebinds.get(id);
  }

  hasRebind(id: string): boolean {
    return this.pendingRebinds.has(id);
  }

  setRebind(id: string, value: Reb): void {
    this.pendingRebinds.set(id, value);
    this.notifySettled(id);
  }

  deleteRebind(id: string): boolean {
    const deleted = this.pendingRebinds.delete(id);
    this.notifySettled(id);
    return deleted;
  }

  /** Live iteration lets cleanup commits delete receipts while a flush is in progress. */
  get deferredCleanups(): ReadonlyMap<Cleanup, { sessionId: string; deviceId: string }> {
    return this.deferredCleanupOwners;
  }

  setDeferredCleanup(cleanup: Cleanup, owner: { sessionId: string; deviceId: string }): void {
    this.deferredCleanupOwners.set(cleanup, owner);
  }

  deleteDeferredCleanup(cleanup: Cleanup): boolean {
    return this.deferredCleanupOwners.delete(cleanup);
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

// Each skipped path is already legal in design §3.1. Hooks do not observe the absent
// admission fence between failure and cleanup, or ended while older work still covers a UUID.
const COARSE_SLOT_PATHS: readonly {
  event: string;
  from: SlotPhase;
  via: SlotPhase;
  to: SlotPhase;
}[] = [
  { event: "published", from: "absent", via: "creating", to: "live" },
  { event: "assignment-end", from: "assigning", via: "absent", to: "fenced" },
  { event: "creation-end", from: "creating", via: "absent", to: "fenced" },
  { event: "unpublished", from: "releasing", via: "ended", to: "creating" },
];

// docs/design-docs/session-state-record.md §4 "S7 guard findings" documents these
// seven §3.1 gaps and the four coarse paths above. Count both at debug: they are known
// observations, so warning or throwing would add production noise without a new finding.
// Scope each exception to its actual hook so it cannot silently bless a new transition.
const REPORTED_SLOT_TRANSITIONS = new Set([
  "assignment-start:ended:assigning", // revival first needs automatic device assignment
  "assignment-end:assigning:ended", // failed assignment reveals the old finalized identity
  "creation-end:creating:assigning", // creation clears before its covering assignment
  "creation-end:creating:ended", // failed creation reveals the old finalized identity
  "unpublished:releasing:assigning", // unpublication reveals the covering assignment
  "release-end:ended:fenced", // terminal upgrade of a finalized non-terminal release
  "release-end:ended:live", // shutdown test injects a replacement without a publish hook
]);

/** Diagnostic only; hook bookkeeping is synchronous and never drives lifecycle decisions. */
export class SlotTransitionGuard {
  illegalTransitionCount = 0;
  private readonly positions = new Map<string, SlotPosition>();
  private baselineAfterReset = false;

  constructor(
    private readonly logger: { debug(message: string): void; warn(message: string): void },
  ) {}

  /** Off mode leaves unobserved transitions; resume from each UUID's first new observation. */
  reset(): void {
    this.positions.clear();
    this.baselineAfterReset = true;
  }

  /** Finalization cleanup releases ended UUID bookkeeping along with its weak identity. */
  forget(uuid: string): void {
    this.positions.delete(uuid);
  }

  check(uuid: string, event: string, to: SlotPosition, mode: "throw" | "log"): void {
    const from = this.positions.get(uuid) ?? (this.baselineAfterReset ? to : { tag: "absent" });
    if (to.tag === "absent") {
      this.positions.delete(uuid);
    } else {
      this.positions.set(uuid, { tag: to.tag, fence: to.fence });
    }
    if (from.tag === to.tag && from.fence === to.fence) {
      return;
    }
    const result = checkSlotTransition(from, to);
    if (result.ok) {
      return;
    }
    const known =
      REPORTED_SLOT_TRANSITIONS.has(`${event}:${from.tag}:${to.tag}`) ||
      COARSE_SLOT_PATHS.some(
        (path) =>
          path.event === event &&
          path.from === from.tag &&
          path.to === to.tag &&
          checkSlotTransition(from, { tag: path.via }).ok &&
          checkSlotTransition({ tag: path.via }, to).ok,
      );
    this.illegalTransitionCount++;
    const message = `[SlotTransitionGuard] uuid=${uuid} event=${event}: ${result.reason}`;
    if (known) {
      this.logger.debug(message);
      return;
    }
    if (mode === "throw") {
      throw new SlotTransitionError(from, to, message);
    }
    this.logger.warn(message);
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
  const tag = deriveSlotTag(view, uuid);
  const slot: DerivedSlot = {
    tag,
    releaseRequested: (tag === "creating" || tag === "assigning") && view.pendingReleases.has(uuid),
  };
  if (tag === "releasing") {
    slot.fence = view.terminalSnapshots.has(uuid) ? "terminal" : "none";
  }
  if (
    !isSlotTagBeingRecreated(tag) &&
    (view.pendingReleases.has(uuid) || view.pendingRebinds.has(uuid) || view.releaseOps.has(uuid))
  ) {
    slot.residue = true;
  }
  return slot;
}

/** The hot predicates need only the tag; do not allocate a DerivedSlot for those reads. */
export function deriveSlotTag<S>(view: LegacyLifecycleView<S>, uuid: string): SlotPhase {
  const session = view.sessions.get(uuid);
  if (session !== undefined) {
    return derivePublishedSlotTag(view, uuid, session);
  }
  if (view.pendingCreations.has(uuid)) {
    return "creating";
  }
  if (view.pendingAssignments.has(uuid)) {
    return "assigning";
  }
  if (view.terminalSnapshots.has(uuid) || view.recoveredTerminalIntents.has(uuid)) {
    return "fenced";
  }
  if (
    view.releaseOps.has(uuid) ||
    view.latestFinalizedIdentities.get(uuid)?.deref() !== undefined
  ) {
    return "ended";
  }
  return "absent";
}

function derivePublishedSlotTag<S>(
  view: LegacyLifecycleView<S>,
  uuid: string,
  session: S,
): SlotTag {
  const op = view.releaseOps.get(uuid);
  if (
    view.terminalSnapshots.has(uuid) ||
    view.isReleasing(session) ||
    (op?.session === session && !op.forced && !op.commitDeclined)
  ) {
    return "releasing";
  }
  return view.pendingRebinds.has(uuid) ? "rebinding" : "live";
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

/** Identity read for the shadow model, including unpublished and finalized incarnations. */
export function deriveLatestSessionIdentity<S>(
  view: LegacyLifecycleView<S>,
  uuid: string,
  ignorePendingAssignment = false,
): S | undefined {
  const published = view.sessions.get(uuid);
  if (published !== undefined) {
    return published;
  }
  if (
    view.pendingCreations.has(uuid) ||
    (!ignorePendingAssignment && view.pendingAssignments.has(uuid))
  ) {
    return undefined;
  }
  return view.releaseOps.get(uuid)?.session ?? view.latestFinalizedIdentities.get(uuid)?.deref();
}

/** Currentness includes non-terminal release windows before and after WeakSet cleanup. */
export function isSlotCurrentSession<S>(
  view: LegacyLifecycleView<S>,
  uuid: string,
  session: S,
): boolean {
  if (view.sessions.get(uuid) !== session) {
    return false;
  }
  const tag = deriveSlotTag(view, uuid);
  return (
    tag === "live" ||
    tag === "rebinding" ||
    (tag === "releasing" && !view.terminalSnapshots.has(uuid))
  );
}

/** The device index holds both published sessions and unpublished release operations. */
export function deriveHeldSlotSession<S>(
  view: LegacyLifecycleView<S>,
  uuid: string,
): S | undefined {
  return view.sessions.get(uuid) ?? view.releaseOps.get(uuid)?.session;
}

/** Preserve the public union's insertion order, including otherwise-ended residue. */
export function deriveKnownSessionIds<S>(view: LegacyLifecycleView<S>): string[] {
  return [
    ...new Set([
      ...view.sessions.keys(),
      ...view.pendingCreations.keys(),
      ...view.pendingAssignments.keys(),
      ...view.pendingRebinds.keys(),
      ...view.pendingReleases.keys(),
      ...view.releaseOps.keys(),
    ]),
  ].filter((uuid) => isSlotKnown(deriveSlot(view, uuid)));
}
