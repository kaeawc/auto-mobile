import { createHash } from "node:crypto";
import type { ListChangedKind } from "../listChangedBroadcast";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * Slow by design: polling only runs while the daemon's list_changed push is
 * unavailable, and each tick costs one `tools/list` plus one `resources/list`.
 */
export const DEFAULT_LIST_POLL_INTERVAL_MS = 30_000;

const POLLED_KINDS: readonly ListChangedKind[] = ["tools", "resources"];

export interface ToolListPollerDependencies {
  timer: Pick<Timer, "setInterval" | "clearInterval">;
  intervalMs?: number;
  /**
   * The daemon's current list for `kind`, read past every cache. Resolves
   * undefined when it cannot be read right now (no live connection); it must
   * never connect to or start the daemon.
   */
  fetchList(kind: ListChangedKind): Promise<unknown>;
  /** Announce a list change to the proxy's clients. */
  emitListChanged(kind: ListChangedKind): void;
}

function hashList(list: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(list) ?? "")
    .digest("hex");
}

/**
 * Fallback for daemon-pushed list_changed (#4678). The push path
 * (ListChangedBroadcaster -> socket notification subscribers -> DaemonMcpProxy)
 * stays primary. When the proxy's notification subscription is not
 * acknowledged, this polls `tools/list` and `resources/list` on a slow interval
 * and re-emits list_changed when a list's hash changes. A connection that drops
 * while polling compares once against the last list seen when the next one is
 * established, so a change made while disconnected is still announced. Hashes
 * survive a drop, so a connection whose subscription then fails compares its
 * first poll against the list seen before the drop.
 *
 * Each list state is announced at most once: the baseline hash is
 * compare-and-set synchronously after every read, so a push that arrives while
 * polling ({@link onPushed}) and a timer tick that read the same change cannot
 * both emit. A list_changed the proxy emits for its own reasons
 * ({@link noteEmitted}) clears the baseline, and the next read adopts the new
 * list silently.
 */
export class ToolListPoller {
  private readonly timer: Pick<Timer, "setInterval" | "clearInterval">;
  private readonly intervalMs: number;
  private readonly fetchList: (kind: ListChangedKind) => Promise<unknown>;
  private readonly emitListChanged: (kind: ListChangedKind) => void;
  private readonly baselines = new Map<ListChangedKind, string>();
  private interval: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private reconcileOnNextConnection = false;
  /** Bumped by every subscription verdict, drop and stop; a stale verdict must not start polling. */
  private connectionEpoch = 0;
  private readSequence = 0;
  /** The newest read sequence whose result (or invalidation) was applied, per list kind. */
  private readonly appliedSequence = new Map<ListChangedKind, number>();

  constructor(deps: ToolListPollerDependencies) {
    this.timer = deps.timer;
    this.intervalMs = deps.intervalMs ?? DEFAULT_LIST_POLL_INTERVAL_MS;
    this.fetchList = deps.fetchList;
    this.emitListChanged = deps.emitListChanged;
  }

  isPolling(): boolean {
    return this.interval !== null;
  }

  /** Record a list the proxy fetched for its client, without emitting. */
  observe(kind: ListChangedKind, list: unknown): void {
    this.baselines.set(kind, hashList(list));
    this.fenceInFlightReads(kind);
  }

  /** The proxy announced a change itself; the next read is the new baseline. */
  noteEmitted(kind: ListChangedKind): void {
    this.baselines.delete(kind);
    this.fenceInFlightReads(kind);
  }

  /**
   * A daemon push arrived while polling. It is announced only if no poll
   * already announced the same list; when the list cannot be read or compared,
   * it is announced anyway.
   */
  async onPushed(kind: ListChangedKind): Promise<void> {
    if (this.baselines.has(kind) && (await this.pollKind(kind))) {
      return;
    }
    this.baselines.delete(kind);
    this.emitListChanged(kind);
  }

  /**
   * The connection, and its subscription, dropped. While push was healthy the
   * reconnect behaves as before; while polling, the next connection compares once.
   */
  markDropped(): void {
    this.connectionEpoch++;
    this.reconcileOnNextConnection ||= this.isPolling();
    this.stopInterval();
  }

  /** Push works on this connection: stop polling after any pending comparison. */
  async onSubscriptionAcknowledged(): Promise<void> {
    this.connectionEpoch++;
    this.stopInterval();
    await this.reconcileIfDropped();
  }

  /** Push is unavailable on this connection: poll until it is acknowledged. */
  async onSubscriptionUnavailable(): Promise<void> {
    const epoch = ++this.connectionEpoch;
    await this.reconcileIfDropped();
    // A newer acknowledgement, drop or stop arrived while the comparison was pending.
    if (epoch !== this.connectionEpoch) {
      return;
    }
    if (this.interval) {
      return;
    }
    this.interval = this.timer.setInterval(() => void this.tick(), this.intervalMs);
    // A background poll must never keep the proxy process alive.
    const handle = this.interval as { unref?: () => void };
    if (typeof handle.unref === "function") {
      handle.unref();
    }
  }

  stop(): void {
    this.connectionEpoch++;
    this.stopInterval();
    this.reconcileOnNextConnection = false;
    this.baselines.clear();
  }

  /** Reads already in flight predate this baseline change; their results are discarded. */
  private fenceInFlightReads(kind: ListChangedKind): void {
    this.appliedSequence.set(kind, ++this.readSequence);
  }

  private stopInterval(): void {
    if (this.interval) {
      this.timer.clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async reconcileIfDropped(): Promise<void> {
    if (!this.reconcileOnNextConnection) {
      return;
    }
    this.reconcileOnNextConnection = false;
    // Only a list seen before the drop can be compared.
    for (const kind of POLLED_KINDS.filter((polled) => this.baselines.has(polled))) {
      await this.pollKind(kind);
    }
  }

  private async tick(): Promise<void> {
    // A slow daemon must not stack overlapping polls.
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      await this.pollAll();
    } finally {
      this.tickInFlight = false;
    }
  }

  private async pollAll(): Promise<void> {
    for (const kind of POLLED_KINDS) {
      await this.pollKind(kind);
    }
  }

  /** Read one list and announce it if its hash changed. False when it could not be read. */
  private async pollKind(kind: ListChangedKind): Promise<boolean> {
    const sequence = ++this.readSequence;
    let list: unknown;
    try {
      list = await this.fetchList(kind);
    } catch (error) {
      // Expected while the daemon restarts or is busy: the next tick or
      // reconnect reads again, and the push path is unaffected.
      logger.debug(`[ToolListPoller] ${kind}/list poll failed: ${errorMessage(error)}`);
      return false;
    }
    if (list === undefined) {
      return false;
    }
    // Reads can overlap (interval tick vs push); an older read that finishes last
    // must not overwrite the newer baseline and re-announce a list already seen.
    if (sequence < (this.appliedSequence.get(kind) ?? 0)) {
      return true;
    }
    this.appliedSequence.set(kind, sequence);
    const hash = hashList(list);
    const previous = this.baselines.get(kind);
    this.baselines.set(kind, hash);
    if (previous !== undefined && previous !== hash) {
      this.emitListChanged(kind);
    }
    return true;
  }
}
