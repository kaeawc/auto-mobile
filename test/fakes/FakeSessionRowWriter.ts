import type {
  DesiredReleaseRow,
  ReleaseRowLanded,
  ReleaseRowRetry,
  ReleaseRowRetryCallbacks,
  SessionRowWriter,
} from "../../src/daemon/sessionRowWriter";
import { MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS } from "../../src/daemon/sessionRowWriter";
import type { BackoffPolicy } from "../../src/utils/Backoff";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";

/** Manually landed release desires, with no persistence or clock access. */
export class FakeSessionRowWriter implements SessionRowWriter {
  readonly desires = new Map<string, DesiredReleaseRow>();
  private readonly retries = new Map<
    string,
    ReleaseRowRetry & { callbacks: ReleaseRowRetryCallbacks }
  >();
  private draining = false;
  private seq = 0;
  private readonly liveSequences = new Map<string, number>();
  private readonly releaseSequences = new WeakMap<SessionReleaseSnapshot, number>();

  noteLive(uuid: string): void {
    this.liveSequences.set(uuid, ++this.seq);
  }

  noteRelease(snapshot: SessionReleaseSnapshot): void {
    if (!this.releaseSequences.has(snapshot)) {
      this.releaseSequences.set(snapshot, ++this.seq);
    }
  }

  canIssueRelease(snapshot: SessionReleaseSnapshot): boolean {
    return (
      !snapshot.terminal ||
      (this.releaseSequences.get(snapshot) ?? Infinity) >
        (this.liveSequences.get(snapshot.sessionId) ?? 0)
    );
  }
  private readonly outcomes = new Map<string, ReturnType<typeof Promise.withResolvers<boolean>>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly listeners = new Set<(event: ReleaseRowLanded) => void | Promise<unknown>>();
  private readonly drainWrites = new Set<Promise<void>>();
  private readonly nonTerminalSnapshots = new Map<string, SessionReleaseSnapshot>();

  desire(uuid: string, desired: DesiredReleaseRow): void {
    if (this.desires.get(uuid)?.terminal && !desired.terminal) {
      return;
    }
    this.outcomes.get(uuid)?.resolve(false);
    this.desires.set(uuid, desired);
    this.outcomes.set(uuid, Promise.withResolvers<boolean>());
  }

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
    if (this.draining && pending?.snapshot === snapshot && pending.shutdownAttempted) {
      this.cancelRetry(snapshot);
      return;
    }
    const entry = {
      snapshot,
      callbacks,
      shutdownAttempted: this.draining,
      isCurrent: () => this.retries.get(uuid) === entry,
    };
    this.retries.set(uuid, entry);
    if (this.draining) {
      this.trackDrainWrite(callbacks.run(entry));
    }
  }

  cancelRetry(snapshot: SessionReleaseSnapshot): void {
    if (this.retries.get(snapshot.sessionId)?.snapshot !== snapshot) {
      return;
    }
    this.retries.delete(snapshot.sessionId);
    this.resolveWaiters(snapshot.sessionId);
  }

  beginReleaseDrain(): void {
    this.draining = true;
  }

  retryPendingNow(): Promise<void>[] {
    return Array.from(this.retries.values(), (entry) => {
      entry.shutdownAttempted = true;
      return entry.callbacks.run(entry);
    });
  }

  // This fake holds manually driven retries and never arms timers or consumes a backoff.
  stopRetryTimers(): void {}
  setRetryBackoff(_backoff: BackoffPolicy): void {}

  pendingNonTerminalReleases(): ReadonlyMap<string, SessionReleaseSnapshot> {
    return this.nonTerminalSnapshots;
  }

  recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void {
    if (
      !this.nonTerminalSnapshots.has(snapshot.sessionId) &&
      this.nonTerminalSnapshots.size >= MAX_PENDING_NON_TERMINAL_RELEASE_SNAPSHOTS
    ) {
      const oldest = this.nonTerminalSnapshots.keys().next().value;
      if (oldest !== undefined) {
        this.nonTerminalSnapshots.delete(oldest);
      }
    }
    this.nonTerminalSnapshots.set(snapshot.sessionId, snapshot);
  }

  deletePendingNonTerminalRelease(uuid: string): void {
    this.nonTerminalSnapshots.delete(uuid);
  }

  clearPendingNonTerminalReleases(): void {
    this.nonTerminalSnapshots.clear();
  }

  pending(uuid: string): boolean {
    return this.desires.has(uuid) || this.retries.has(uuid);
  }

  pendingSnapshot(uuid: string): SessionReleaseSnapshot | undefined {
    return this.desires.get(uuid)?.snapshot;
  }

  result(uuid: string): Promise<boolean> {
    return this.outcomes.get(uuid)?.promise ?? Promise.resolve(true);
  }

  settled(uuid: string): Promise<void> {
    if (!this.pending(uuid)) {
      return Promise.resolve();
    }
    const waiters = this.waiters.get(uuid) ?? new Set();
    this.waiters.set(uuid, waiters);
    return new Promise((resolve) => waiters.add(resolve));
  }

  async land(uuid: string, refused = false): Promise<void> {
    const desired = this.desires.get(uuid);
    if (!desired) {
      return;
    }
    this.outcomes.get(uuid)?.resolve(true);
    this.cancel(uuid, desired.snapshot);
    for (const listener of this.listeners) {
      await listener({ snapshot: desired.snapshot, late: false, refused });
    }
  }

  cancel(uuid: string, snapshot: SessionReleaseSnapshot): void {
    if (this.desires.get(uuid)?.snapshot !== snapshot) {
      return;
    }
    this.desires.delete(uuid);
    this.outcomes.get(uuid)?.resolve(false);
    this.outcomes.delete(uuid);
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

  liftTerminal(uuid: string): void {
    const retry = this.retries.get(uuid);
    if (retry?.snapshot.terminal) {
      this.cancelRetry(retry.snapshot);
      this.cancel(uuid, retry.snapshot);
    }
    const desired = this.desires.get(uuid);
    if (desired?.terminal) {
      this.cancel(uuid, desired.snapshot);
    }
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
    if (retries.length > 0) {
      await Promise.allSettled(retries);
    }
    while (this.drainWrites.size || this.desires.size || this.retries.size) {
      await Promise.all([
        ...this.drainWrites,
        ...Array.from(new Set([...this.desires.keys(), ...this.retries.keys()]), (uuid) =>
          this.settled(uuid),
        ),
      ]);
    }
  }

  stop(): void {
    for (const [uuid, desired] of this.desires) {
      if (!desired.terminal) {
        this.cancel(uuid, desired.snapshot);
      }
    }
  }

  onRowLanded(listener: (event: ReleaseRowLanded) => void | Promise<unknown>): void {
    this.listeners.add(listener);
  }
}
