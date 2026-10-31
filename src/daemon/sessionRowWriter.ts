import {
  DeviceSessionRowNotReleasableError,
  type DeviceSessionActivityUpdate,
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
  type MarkReleasedOptions,
  type UpsertActiveSessionOptions,
} from "../db/deviceSessionRepository";
import type { BackoffPolicy } from "../utils/Backoff";
import { errorMessage } from "../utils/describeUnknownError";
import type { Logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { releasedRowStatus } from "./releaseReasons";
import type { SessionReleaseSnapshot } from "./sessionManager";
import { SupersededRowReasserts } from "./supersededRowReasserts";

export const MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS = 256;

export interface DesiredReleaseRow {
  snapshot: SessionReleaseSnapshot;
  terminal: boolean;
  /** Preserve first-statement timing; retries obtain a fresh SQL generation guard. */
  initialPrecondition?: MarkReleasedOptions;
  precondition: () => Promise<MarkReleasedOptions>;
  wanted?: () => boolean;
  /** Recreation can defer an owed write without discarding it. */
  due?: (draining: boolean) => Promise<boolean>;
  beforeWrite?: () => Promise<void>;
  /** A skipped non-terminal statement can still owe its row after a failed reissue. */
  skipped?: () => Promise<boolean>;
  fallback?: (
    error: DeviceSessionRowNotReleasableError,
    options: MarkReleasedOptions,
    write: (options: MarkReleasedOptions) => Promise<void>,
  ) => Promise<void>;
  failure?: (error: unknown) => boolean;
  /** The manager's superseded-row repair remains owed until the parked statement settles. */
  parked?: () => (() => void) | undefined;
}

export interface ReleaseRowLanded {
  snapshot: SessionReleaseSnapshot;
  late: boolean;
  refused: boolean;
}

/**
 * Live-row statements (create, rebind, activity). W3 adapter: the writer issues the statement and
 * returns the persistence promise unchanged, so callers keep their await sequence and the
 * statement-level guards (`unlessTerminal`, rewrite-over-release) stay in SQL. Per-UUID
 * serialization of these writes is not added here.
 */
export interface LiveRowWrites {
  upsertLive(
    record: DeviceSessionRecord,
    nowMs: number,
    options?: UpsertActiveSessionOptions,
  ): Promise<number | void>;
  recordLiveActivity(uuid: string, update: DeviceSessionActivityUpdate): Promise<void>;
  replaceLiveOwnership(uuid: string, ownerToken: string | null): Promise<void>;
}

export interface SessionRowWriter extends LiveRowWrites {
  /** Superseded-row rewrite state and owed-rewrite scheduling (#11799 W3). */
  readonly superseded: SupersededRowReasserts;
  desire(uuid: string, desired: DesiredReleaseRow): void;
  noteLive(uuid: string): void;
  noteRelease(snapshot: SessionReleaseSnapshot): void;
  canIssueRelease(snapshot: SessionReleaseSnapshot): boolean;
  scheduleRetry(snapshot: SessionReleaseSnapshot, callbacks: ReleaseRowRetryCallbacks): void;
  cancelRetry(snapshot: SessionReleaseSnapshot): void;
  beginReleaseDrain(): void;
  retryPendingNow(): Promise<void>[];
  stopRetryTimers(): void;
  setRetryBackoff(backoff: BackoffPolicy): void;
  /** Caller-owned non-terminal releases, in their original insertion order. */
  pendingNonTerminalReleases(): ReadonlyMap<string, SessionReleaseSnapshot>;
  recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void;
  deletePendingNonTerminalRelease(uuid: string): void;
  clearPendingNonTerminalReleases(): void;
  pending(uuid: string): boolean;
  settled(uuid: string): Promise<void>;
  /** Track background writes without wrapping their promises or changing settlement timing. */
  trackDrainWrite(write: Promise<void>): void;
  /** Live read-only set; callers take their drain snapshots synchronously. */
  pendingDrainWrites(): ReadonlySet<Promise<void>>;
  drain(): Promise<void>;
  cancel(uuid: string, snapshot: SessionReleaseSnapshot): void;
  liftTerminal(uuid: string): void;
  onRowLanded(listener: ReleaseRowListener): void;
  /** First-attempt outcome; separate from settled(), which never rejects and includes retries. */
  result(uuid: string): Promise<boolean>;
  pendingSnapshot(uuid: string): SessionReleaseSnapshot | undefined;
  stop(): void;
}

type ReleaseRowListener = (event: ReleaseRowLanded) => void | Promise<unknown>;

/** Identity and drain state of one scheduled retry; row policy remains with its caller. */
export interface ReleaseRowRetry {
  snapshot: SessionReleaseSnapshot;
  shutdownAttempted?: boolean;
  isCurrent(): boolean;
}

export interface ReleaseRowRetryCallbacks {
  isStillOwed(): boolean;
  drop(): void;
  run(entry: ReleaseRowRetry): Promise<void>;
}

interface ScheduledReleaseRowRetry extends ReleaseRowRetry {
  attempt: number;
  handle?: NodeJS.Timeout;
  callbacks: ReleaseRowRetryCallbacks;
}

interface Desire {
  desired: DesiredReleaseRow;
  desireSeq: number;
  cancelled: boolean;
  attempt: number;
  shutdownAttempted: boolean;
  handle?: NodeJS.Timeout;
  outcome: ReturnType<typeof Promise.withResolvers<boolean>>;
}

interface Row {
  desired?: Desire;
  active?: Desire;
  parked: number;
  /** A fence lift signals a live desire until W3 moves live writes into this writer. */
  liveSeq: number;
}

interface SessionRowWriterOptions {
  logger: Pick<Logger, "warn" | "debug">;
  timeoutMs: number;
  timeoutError: (snapshot: SessionReleaseSnapshot) => Error;
}

interface SessionRowWriterCollaborators {
  persistence: DeviceSessionPersistence;
  timer: Timer;
  backoff: BackoffPolicy;
  logger: Pick<Logger, "warn" | "debug">;
  timeoutMs: number;
  timeoutError: new (sessionId: string, releaseReason: string, timeoutMs: number) => Error;
}

/** RELEASE statements only. Slots explicitly revoke desires; this module never reads slots. */
export class SerializedSessionRowWriter implements SessionRowWriter {
  /** Construct the default manager adapter. */
  static create(collaborators: SessionRowWriterCollaborators): SessionRowWriter {
    const {
      persistence,
      timer,
      backoff,
      logger,
      timeoutMs,
      timeoutError: TimeoutError,
    } = collaborators;
    return new SerializedSessionRowWriter(persistence, timer, backoff, {
      logger,
      timeoutMs,
      timeoutError: (snapshot) =>
        new TimeoutError(snapshot.sessionId, snapshot.releaseReason, timeoutMs),
    });
  }

  private readonly rows = new Map<string, Row>();
  private readonly listeners = new Set<ReleaseRowListener>();
  private readonly work = new Set<Promise<void>>();
  private readonly drainWrites = new Set<Promise<void>>();
  private readonly retries = new Map<string, ScheduledReleaseRowRetry>();
  private readonly nonTerminalSnapshots = new Map<string, SessionReleaseSnapshot>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly liveSequences = new Map<string, WeakRef<{ seq: number }>>();
  private readonly releaseSequences = new WeakMap<
    SessionReleaseSnapshot,
    { seq: number; live: { seq: number } }
  >();
  // Snapshots retain their epoch; ended UUID names alone must not retain generation metadata.
  private readonly finalizedGenerations = new FinalizationRegistry<{
    uuid: string;
    ref: WeakRef<{ seq: number }>;
  }>(({ uuid, ref }) => {
    if (this.liveSequences.get(uuid) === ref) {
      this.liveSequences.delete(uuid);
    }
  });
  private desireSeq = 0;
  private draining = false;
  readonly superseded: SupersededRowReasserts;

  private readonly logger: Pick<Logger, "warn" | "debug">;
  private readonly options: Omit<SessionRowWriterOptions, "logger">;

  /**
   * @param persistence - Durable session-row store
   * @param timer - Clock for retries and write deadlines
   * @param backoff - Retry backoff policy
   * @param options.logger - Warn/debug sink
   * @param options.timeoutMs - Per-release write deadline
   * @param options.timeoutError - Builds the error a timed-out write rejects with
   */
  constructor(
    private readonly persistence: DeviceSessionPersistence,
    private readonly timer: Timer,
    private backoff: BackoffPolicy,
    { logger, ...options }: SessionRowWriterOptions,
  ) {
    this.logger = logger;
    this.options = options;
    this.superseded = new SupersededRowReasserts({
      timer,
      logger,
      draining: () => this.draining,
      trackDrainWrite: (write) => this.trackDrainWrite(write),
    });
  }

  /** W2 adapter: register once, including first attempts whose promise timing stays in the manager. */
  noteRelease(snapshot: SessionReleaseSnapshot): void {
    if (!this.releaseSequences.has(snapshot)) {
      const uuid = snapshot.sessionId;
      const live = this.liveSequences.get(uuid)?.deref() ?? { seq: 0 };
      if (!this.liveSequences.get(uuid)?.deref()) {
        const ref = new WeakRef(live);
        this.liveSequences.set(uuid, ref);
        this.finalizedGenerations.register(live, { uuid, ref });
      }
      this.releaseSequences.set(snapshot, { seq: ++this.desireSeq, live });
    }
  }

  noteLive(uuid: string): void {
    const seq = ++this.desireSeq;
    const live = this.liveSequences.get(uuid)?.deref();
    if (live) {
      live.seq = seq;
    }
    const row = this.rows.get(uuid);
    if (row) {
      row.liveSeq = seq;
    }
  }

  upsertLive(
    record: DeviceSessionRecord,
    nowMs: number,
    options?: UpsertActiveSessionOptions,
  ): Promise<number | void> {
    return this.persistence.upsertActiveSession(record, nowMs, options);
  }

  recordLiveActivity(uuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    return this.persistence.recordActivity(uuid, update);
  }

  replaceLiveOwnership(uuid: string, ownerToken: string | null): Promise<void> {
    return this.persistence.replaceLivenessOwnership(uuid, ownerToken);
  }

  canIssueRelease(snapshot: SessionReleaseSnapshot): boolean {
    const desire = this.releaseSequences.get(snapshot);
    return !snapshot.terminal || !desire || desire.seq > desire.live.seq;
  }

  desire(uuid: string, desired: DesiredReleaseRow): void {
    const row = this.rows.get(uuid) ?? { liveSeq: 0, parked: 0 };
    if (row.desired?.desired.terminal && !desired.terminal) {
      return;
    }
    if (row.desired && row.desired !== row.active) {
      this.revoke(row.desired);
    }
    const entry: Desire = {
      desired,
      desireSeq: ++this.desireSeq,
      cancelled: false,
      attempt: 0,
      shutdownAttempted: false,
      outcome: Promise.withResolvers<boolean>(),
    };
    // The manager may abandon a caller at its deadline; the writer always observes the outcome.
    void entry.outcome.promise.catch((error: unknown) => {
      this.logger.warn(`Release row caller failed for ${uuid}: ${errorMessage(error)}`, error);
    });
    row.desired = entry;
    this.rows.set(uuid, row);
    this.evictNonTerminal();
    this.start(uuid, row, entry);
  }

  /** Schedule only: callbacks keep their original promise and await sequence. */
  scheduleRetry(snapshot: SessionReleaseSnapshot, callbacks: ReleaseRowRetryCallbacks): void {
    this.noteRelease(snapshot);
    const uuid = snapshot.sessionId;
    const pending = this.retries.get(uuid);
    if (!snapshot.terminal && pending?.snapshot.terminal) {
      return;
    }
    if (!callbacks.isStillOwed()) {
      callbacks.drop();
      return;
    }
    const attempt = (pending?.snapshot === snapshot ? pending.attempt : 0) + 1;
    if (pending?.handle !== undefined) {
      this.timer.clearTimeout(pending.handle);
    }
    const entry: ScheduledReleaseRowRetry = {
      snapshot,
      attempt,
      callbacks,
      shutdownAttempted: this.draining,
      isCurrent: () => this.retries.get(uuid) === entry,
    };
    if (this.draining) {
      this.retryDuringDrain(entry, pending);
      return;
    }
    entry.handle = this.timer.setTimeout(() => {
      entry.handle = undefined;
      void callbacks.run(entry);
    }, this.backoff.delayForAttempt(attempt));
    entry.handle.unref?.();
    this.retries.set(uuid, entry);
    this.logger.warn(
      `[SessionManager] The ${snapshot.releaseReason} release of session ${uuid} ` +
        `is not persisted; retrying the write (attempt ${attempt})`,
    );
  }

  /** One immediate attempt per owed snapshot; a further failure cannot spin shutdown. */
  private retryDuringDrain(
    entry: ScheduledReleaseRowRetry,
    pending: ScheduledReleaseRowRetry | undefined,
  ): void {
    const { snapshot, attempt, callbacks } = entry;
    const uuid = snapshot.sessionId;
    if (pending?.snapshot === snapshot && pending.shutdownAttempted) {
      this.removeRetry(uuid);
      this.logger.warn(
        `[SessionManager] The ${snapshot.releaseReason} release of session ` +
          `${uuid} is still not persisted at shutdown` +
          (snapshot.terminal ? "; the session stays fenced only until this process exits" : ""),
      );
      return;
    }
    this.retries.set(uuid, entry);
    this.logger.warn(
      `[SessionManager] The ${snapshot.releaseReason} release of session ${uuid} ` +
        `is not persisted; retrying the write before shutdown (attempt ${attempt})`,
    );
    this.trackDrainWrite(callbacks.run(entry));
  }

  cancelRetry(snapshot: SessionReleaseSnapshot): void {
    if (this.retries.get(snapshot.sessionId)?.snapshot === snapshot) {
      this.removeRetry(snapshot.sessionId);
    }
  }

  private removeRetry(uuid: string): void {
    const entry = this.retries.get(uuid);
    if (entry?.handle !== undefined) {
      this.timer.clearTimeout(entry.handle);
    }
    this.retries.delete(uuid);
    this.resolveWaiters(uuid);
  }

  private resolveWaiters(uuid: string): void {
    if (this.pending(uuid)) {
      return;
    }
    for (const resolve of this.waiters.get(uuid) ?? []) {
      resolve();
    }
    this.waiters.delete(uuid);
  }

  beginReleaseDrain(): void {
    this.draining = true;
  }

  /** Snapshot synchronously and return the caller's original write promises. */
  retryPendingNow(): Promise<void>[] {
    return Array.from(this.retries.values(), (entry) => {
      if (entry.handle !== undefined) {
        this.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
      entry.shutdownAttempted = true;
      return entry.callbacks.run(entry);
    });
  }

  stopRetryTimers(): void {
    for (const entry of this.retries.values()) {
      if (entry.handle !== undefined) {
        this.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
    }
  }

  setRetryBackoff(backoff: BackoffPolicy): void {
    this.backoff = backoff;
  }

  pendingNonTerminalReleases(): ReadonlyMap<string, SessionReleaseSnapshot> {
    return this.nonTerminalSnapshots;
  }

  recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void {
    const pending = this.nonTerminalSnapshots;
    if (
      !pending.has(snapshot.sessionId) &&
      pending.size >= MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS
    ) {
      const oldestSessionId = pending.keys().next().value;
      if (oldestSessionId !== undefined) {
        pending.delete(oldestSessionId);
      }
    }
    pending.set(snapshot.sessionId, snapshot);
  }

  deletePendingNonTerminalRelease(uuid: string): void {
    this.nonTerminalSnapshots.delete(uuid);
  }

  clearPendingNonTerminalReleases(): void {
    this.nonTerminalSnapshots.clear();
  }

  private evictNonTerminal(): void {
    const pending = Array.from(this.rows.entries()).filter(
      ([, row]) => row.desired && !row.desired.desired.terminal,
    );
    if (pending.length <= MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS) {
      return;
    }
    const [uuid, row] = pending[0]!;
    this.cancel(uuid, row.desired!.desired.snapshot);
  }

  pending(uuid: string): boolean {
    const row = this.rows.get(uuid);
    return (
      this.retries.has(uuid) ||
      (row !== undefined && (!!row.active || !!row.desired || row.parked > 0))
    );
  }

  pendingSnapshot(uuid: string): SessionReleaseSnapshot | undefined {
    return this.rows.get(uuid)?.desired?.desired.snapshot;
  }

  result(uuid: string): Promise<boolean> {
    return this.rows.get(uuid)?.desired?.outcome.promise ?? Promise.resolve(true);
  }

  settled(uuid: string): Promise<void> {
    if (!this.pending(uuid)) {
      return Promise.resolve();
    }
    const waiters = this.waiters.get(uuid) ?? new Set<() => void>();
    this.waiters.set(uuid, waiters);
    return new Promise((resolve) => waiters.add(resolve));
  }

  cancel(uuid: string, snapshot: SessionReleaseSnapshot): void {
    const row = this.rows.get(uuid);
    if (!row) {
      return;
    }
    if (row.desired?.desired.snapshot === snapshot) {
      this.revoke(row.desired);
      row.desired = undefined;
    }
    if (row.active?.desired.snapshot === snapshot) {
      row.active.cancelled = true;
    }
    this.prune(uuid, row);
  }

  liftTerminal(uuid: string): void {
    const retry = this.retries.get(uuid);
    if (retry?.snapshot.terminal) {
      this.cancelRetry(retry.snapshot);
      this.cancel(uuid, retry.snapshot);
    }
    const row = this.rows.get(uuid);
    if (!row) {
      return;
    }
    row.liveSeq = ++this.desireSeq;
    if (row.active?.desired.terminal) {
      row.active.cancelled = true;
    }
    if (row.desired?.desired.terminal) {
      this.cancel(uuid, row.desired.desired.snapshot);
    }
  }

  private revoke(entry: Desire): void {
    entry.cancelled = true;
    if (entry.handle !== undefined) {
      this.timer.clearTimeout(entry.handle);
    }
    entry.handle = undefined;
    entry.outcome.resolve(false);
  }

  private current(row: Row, entry: Desire): boolean {
    // Terminal generation guard: a newer live desire (fence lift) refuses an unissued terminal row.
    // An issued statement carries its SQL generation guard even after its deadline frees the slot.
    return !entry.cancelled && (!entry.desired.terminal || entry.desireSeq > row.liveSeq);
  }

  private start(uuid: string, row: Row, entry: Desire): void {
    if (row.active || entry.handle !== undefined || row.desired !== entry) {
      return;
    }
    if (!this.current(row, entry) || !(entry.desired.wanted?.() ?? true)) {
      this.cancel(uuid, entry.desired.snapshot);
      return;
    }
    row.active = entry;
    this.track(this.run(uuid, row, entry));
  }

  private async run(uuid: string, row: Row, entry: Desire): Promise<void> {
    let parked = false;
    try {
      const retry = entry.attempt > 0;
      if (retry && !(await this.prepare(row, entry))) {
        return;
      }
      const pendingOptions = this.precondition(entry);
      const options = pendingOptions instanceof Promise ? await pendingOptions : pendingOptions;
      if (!this.current(row, entry)) {
        throw new DeviceSessionRowNotReleasableError(uuid);
      }
      const issue = this.issue(row, entry, options);
      const startedAt = this.deadlineNow();
      let write = issue.write(options);
      const onTimeout = () => {
        parked = true;
        row.parked++;
        const finish = entry.desired.parked?.();
        this.track(
          this.finishParked(uuid, row, entry, { physical: write.catch(issue.fallback), finish }),
        );
      };
      try {
        await this.bounded(write, entry, onTimeout);
      } catch (error) {
        if (parked) {
          throw this.options.timeoutError(entry.desired.snapshot);
        }
        write = issue.fallback(error);
        const elapsed = this.deadlineNow() - startedAt;
        await this.bounded(write, entry, onTimeout, Math.max(0, this.options.timeoutMs - elapsed));
      }
      if (retry && (await entry.desired.skipped?.())) {
        return;
      }
      entry.outcome.resolve(true);
      await this.landed(entry, false, false);
      this.complete(uuid, row, entry);
    } catch (error) {
      await this.failed(uuid, row, entry, { error });
    } finally {
      // The SQL generation guard protects against parked writes after this slot is reused.
      this.unlock(uuid, row, entry);
    }
  }

  private deadlineNow(): number {
    return this.timer.monotonicNow?.() ?? this.timer.now();
  }

  private precondition(entry: Desire): MarkReleasedOptions | Promise<MarkReleasedOptions> {
    return entry.attempt === 0 && entry.desired.initialPrecondition
      ? entry.desired.initialPrecondition
      : entry.desired.precondition();
  }

  private async prepare(row: Row, entry: Desire): Promise<boolean> {
    if (!this.current(row, entry)) {
      throw new DeviceSessionRowNotReleasableError(entry.desired.snapshot.sessionId);
    }
    if (entry.desired.due && !(await entry.desired.due(this.draining))) {
      return false;
    }
    await entry.desired.beforeWrite?.();
    if (!this.current(row, entry)) {
      throw new DeviceSessionRowNotReleasableError(entry.desired.snapshot.sessionId);
    }
    return true;
  }

  private issue(row: Row, entry: Desire, options: MarkReleasedOptions) {
    const { snapshot } = entry.desired;
    const write = (conditions: MarkReleasedOptions) => {
      if (!this.current(row, entry)) {
        return Promise.reject(new DeviceSessionRowNotReleasableError(snapshot.sessionId));
      }
      return this.persistence.markReleased(
        snapshot.sessionId,
        releasedRowStatus(snapshot.releaseReason),
        snapshot.releasedAtMs,
        { reason: snapshot.releaseReason, ...conditions },
      );
    };
    let refusedWrite: Promise<void> | undefined;
    const fallback = (error: unknown): Promise<void> => {
      if (!(error instanceof DeviceSessionRowNotReleasableError) || !entry.desired.fallback) {
        throw error;
      }
      return (refusedWrite ??= entry.desired.fallback(error, options, write));
    };
    return { write, fallback };
  }

  private bounded(
    physical: Promise<void>,
    entry: Desire,
    onTimeout: () => void,
    timeoutMs = this.options.timeoutMs,
  ): Promise<void> {
    return raceWithDeadline(physical, {
      timer: this.timer,
      timeoutMs,
      unref: true,
      label: "Session release persistence",
      timeoutError: () => this.options.timeoutError(entry.desired.snapshot),
      onTimeout,
    });
  }

  private async landed(entry: Desire, late: boolean, refused: boolean): Promise<void> {
    for (const listener of this.listeners) {
      await listener({ snapshot: entry.desired.snapshot, late, refused });
    }
  }

  private async failed(
    uuid: string,
    row: Row,
    entry: Desire,
    { error, late = false }: { error: unknown; late?: boolean },
  ): Promise<void> {
    if (error instanceof DeviceSessionRowNotReleasableError) {
      if (!entry.desired.terminal && (await entry.desired.skipped?.())) {
        return;
      }
      // Expected statement refusal protects a newer row and ends only this desire's intent.
      this.logger.debug(`Release row refused for ${uuid}`);
      entry.outcome.resolve(true);
      await this.landed(entry, late, true);
      this.complete(uuid, row, entry);
      return;
    }
    this.logger.warn(`Release row write failed for ${uuid}: ${errorMessage(error)}`, error);
    try {
      entry.outcome.resolve(entry.desired.failure?.(error) ?? false);
    } catch (failure) {
      entry.outcome.reject(failure);
    }
  }

  private async finishParked(
    uuid: string,
    row: Row,
    entry: Desire,
    { physical, finish }: { physical: Promise<void>; finish?: () => void },
  ): Promise<void> {
    try {
      await physical;
      await this.landed(entry, true, false);
      this.complete(uuid, row, entry);
    } catch (error) {
      await this.failed(uuid, row, entry, { error, late: true });
    } finally {
      finish?.();
      row.parked--;
      this.prune(uuid, row);
    }
  }

  private schedule(uuid: string, row: Row, entry: Desire): void {
    if (row.desired !== entry || !this.current(row, entry)) {
      return;
    }
    if (this.draining && entry.shutdownAttempted) {
      this.logger.warn(`Release row still not persisted at shutdown for ${uuid}`);
      this.complete(uuid, row, entry);
      return;
    }
    entry.attempt++;
    if (this.draining) {
      entry.shutdownAttempted = true;
      this.start(uuid, row, entry);
      return;
    }
    entry.handle = this.timer.setTimeout(() => {
      entry.handle = undefined;
      this.start(uuid, row, entry);
    }, this.backoff.delayForAttempt(entry.attempt));
    entry.handle.unref?.();
  }

  private complete(uuid: string, row: Row, entry: Desire): void {
    if (row.desired === entry) {
      row.desired = undefined;
    }
    if (entry.handle !== undefined) {
      this.timer.clearTimeout(entry.handle);
    }
    this.prune(uuid, row);
  }

  private unlock(uuid: string, row: Row, entry: Desire): void {
    if (row.active === entry) {
      row.active = undefined;
    }
    if (row.desired === entry) {
      this.schedule(uuid, row, entry);
    } else if (row.desired) {
      this.start(uuid, row, row.desired);
    }
    this.prune(uuid, row);
  }

  private prune(uuid: string, row: Row): void {
    if (row.active || row.desired || row.parked > 0) {
      return;
    }
    this.rows.delete(uuid);
    this.resolveWaiters(uuid);
  }

  private track(write: Promise<void>): void {
    const tracked = write.catch((error: unknown) => {
      this.logger.warn(`Release row listener failed: ${errorMessage(error)}`, error);
    });
    this.work.add(tracked);
    void tracked.then(() => this.work.delete(tracked));
  }

  trackDrainWrite(write: Promise<void>): void {
    this.drainWrites.add(write);
    void write.then(() => this.drainWrites.delete(write));
  }

  pendingDrainWrites(): ReadonlySet<Promise<void>> {
    return this.drainWrites;
  }

  async drain(): Promise<void> {
    this.beginReleaseDrain();
    const retries = this.retryPendingNow();
    for (const [uuid, row] of this.rows) {
      if (!row.desired) {
        continue;
      }
      if (row.desired.handle !== undefined) {
        this.timer.clearTimeout(row.desired.handle);
      }
      row.desired.handle = undefined;
      if (!row.active) {
        this.schedule(uuid, row, row.desired);
      }
    }
    if (retries.length > 0) {
      await Promise.allSettled(retries);
    }
    while (this.work.size || this.rows.size || this.drainWrites.size || this.retries.size) {
      await Promise.all([
        ...this.work,
        ...this.drainWrites,
        ...Array.from(new Set([...this.rows.keys(), ...this.retries.keys()]), (uuid) =>
          this.settled(uuid),
        ),
      ]);
    }
  }

  stop(): void {
    this.stopRetryTimers();
    for (const [uuid, row] of this.rows) {
      if (row.desired?.handle !== undefined) {
        this.timer.clearTimeout(row.desired.handle);
      }
      if (row.desired) {
        row.desired.handle = undefined;
      }
      if (row.desired && !row.desired.desired.terminal) {
        this.cancel(uuid, row.desired.desired.snapshot);
      }
    }
  }

  onRowLanded(listener: ReleaseRowListener): void {
    this.listeners.add(listener);
  }
}
