import {
  DeviceSessionRowNotReleasableError,
  type DeviceSessionPersistence,
  type MarkReleasedOptions,
} from "../db/deviceSessionRepository";
import type { BackoffPolicy } from "../utils/Backoff";
import { errorMessage } from "../utils/describeUnknownError";
import type { Logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { releasedRowStatus } from "./releaseReasons";
import type { SessionReleaseSnapshot } from "./sessionManager";

const MAX_PENDING_NON_TERMINAL_RELEASE_ROWS = 256;

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

export interface SessionRowWriter {
  desire(uuid: string, desired: DesiredReleaseRow): void;
  pending(uuid: string): boolean;
  settled(uuid: string): Promise<void>;
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
  waiters: Set<() => void>;
}

interface SessionRowWriterOptions {
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
  /** Accept the manager's existing options/function seam without adding constructor branches there. */
  static create(
    injection: { rowWriter?: SessionRowWriter } | ((...args: never[]) => unknown),
    collaborators: SessionRowWriterCollaborators,
  ): SessionRowWriter {
    const injected = typeof injection === "function" ? undefined : injection.rowWriter;
    const {
      persistence,
      timer,
      backoff,
      logger,
      timeoutMs,
      timeoutError: TimeoutError,
    } = collaborators;
    return (
      injected ??
      new SerializedSessionRowWriter(persistence, timer, backoff, logger, {
        timeoutMs,
        timeoutError: (snapshot) =>
          new TimeoutError(snapshot.sessionId, snapshot.releaseReason, timeoutMs),
      })
    );
  }

  private readonly rows = new Map<string, Row>();
  private readonly listeners = new Set<ReleaseRowListener>();
  private readonly work = new Set<Promise<void>>();
  private desireSeq = 0;
  private draining = false;

  constructor(
    private readonly persistence: DeviceSessionPersistence,
    private readonly timer: Timer,
    private readonly backoff: BackoffPolicy,
    private readonly logger: Pick<Logger, "warn" | "debug">,
    private readonly options: SessionRowWriterOptions,
  ) {}

  desire(uuid: string, desired: DesiredReleaseRow): void {
    const row = this.rows.get(uuid) ?? { liveSeq: 0, parked: 0, waiters: new Set() };
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

  private evictNonTerminal(): void {
    const pending = Array.from(this.rows.entries()).filter(
      ([, row]) => row.desired && !row.desired.desired.terminal,
    );
    if (pending.length <= MAX_PENDING_NON_TERMINAL_RELEASE_ROWS) {
      return;
    }
    const [uuid, row] = pending[0]!;
    this.cancel(uuid, row.desired!.desired.snapshot);
  }

  pending(uuid: string): boolean {
    const row = this.rows.get(uuid);
    return row !== undefined && (!!row.active || !!row.desired || row.parked > 0);
  }

  pendingSnapshot(uuid: string): SessionReleaseSnapshot | undefined {
    return this.rows.get(uuid)?.desired?.desired.snapshot;
  }

  result(uuid: string): Promise<boolean> {
    return this.rows.get(uuid)?.desired?.outcome.promise ?? Promise.resolve(true);
  }

  settled(uuid: string): Promise<void> {
    const row = this.rows.get(uuid);
    if (!row || !this.pending(uuid)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => row.waiters.add(resolve));
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
        return;
      }
      const issue = this.issue(row, entry, options);
      const startedAt = this.deadlineNow();
      let write = issue.write(options);
      const onTimeout = () => {
        parked = true;
        row.parked++;
        const finish = entry.desired.parked?.();
        this.track(this.finishParked(uuid, row, entry, write.catch(issue.fallback), finish));
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
      await this.failed(uuid, row, entry, error);
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
      return false;
    }
    if (entry.desired.due && !(await entry.desired.due(this.draining))) {
      return false;
    }
    await entry.desired.beforeWrite?.();
    return this.current(row, entry);
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
        snapshot.releaseReason,
        conditions,
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
    error: unknown,
    late = false,
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
    physical: Promise<void>,
    finish?: () => void,
  ): Promise<void> {
    try {
      await physical;
      await this.landed(entry, true, false);
      this.complete(uuid, row, entry);
    } catch (error) {
      await this.failed(uuid, row, entry, error, true);
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
    for (const resolve of row.waiters) {
      resolve();
    }
    row.waiters.clear();
  }

  private track(write: Promise<void>): void {
    const tracked = write.catch((error: unknown) => {
      this.logger.warn(`Release row listener failed: ${errorMessage(error)}`, error);
    });
    this.work.add(tracked);
    void tracked.then(() => this.work.delete(tracked));
  }

  async drain(): Promise<void> {
    this.draining = true;
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
    while (this.work.size || this.rows.size) {
      await Promise.all([
        ...this.work,
        ...Array.from(this.rows.keys(), (uuid) => this.settled(uuid)),
      ]);
    }
  }

  stop(): void {
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
