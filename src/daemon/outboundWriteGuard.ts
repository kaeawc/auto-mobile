import type { Timer } from "../utils/SystemTimer";

/**
 * Bytes a client may have queued BEHIND the frame at the head of its outbound
 * queue. The head frame itself is never counted while it drains: a response
 * larger than any fixed cap (an uncapped base64 screenshot) is legitimate, and
 * counting it would destroy a healthy reader on the very next heartbeat reply
 * or notification (issue #10176). Sized well above one large response so two
 * pipelined large responses on a reading client both fit; a client that keeps
 * falling behind beyond this is reaped.
 */
export const DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES = 16 * 1024 * 1024;

/**
 * A reader that frees no queued bytes for this long, while more than
 * {@link DAEMON_RPC_SOCKET_STALL_WATCH_MIN_BYTES} are queued, is stalled. The
 * socket reports progress per completed write chunk (frame), so this must
 * exceed the time a live local reader needs to consume one whole large frame.
 */
export const DAEMON_RPC_SOCKET_WRITE_STALL_TIMEOUT_MS = 60_000;

/** Smaller queues cost little memory and are left to the idle reaper. */
export const DAEMON_RPC_SOCKET_STALL_WATCH_MIN_BYTES = 1024 * 1024;

/** The one socket property the guard reads. */
export interface OutboundQueueView {
  readonly writableLength: number;
}

export interface OutboundWriteStall {
  queuedBytes: number;
  stalledMs: number;
}

/**
 * Per-socket outbound bound. It separates a slow-but-draining reader from a
 * stalled one so that bytes queued in memory stay bounded without punishing a
 * client for one large response:
 *
 * - {@link admit} limits bytes queued behind the head frame (memory bound);
 * - a watchdog on the injected {@link Timer} reports a reader whose queue has
 *   not shrunk for {@link DAEMON_RPC_SOCKET_WRITE_STALL_TIMEOUT_MS}.
 *
 * Frame order is the socket's own: nothing is re-queued here.
 */
export class OutboundWriteGuard {
  /** Total bytes ever admitted; admitted minus `writableLength` is bytes drained. */
  private admitted = 0;
  /** Stream offset just past the frame admitted onto the last empty queue. */
  private headEnd = 0;
  private drainedAtSample = 0;
  private watchdog: NodeJS.Timeout | undefined;

  constructor(
    private readonly socket: OutboundQueueView,
    private readonly timer: Timer,
    private readonly onStalled: (stall: OutboundWriteStall) => void,
    private readonly maxQueuedBytes: number = DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES,
    private readonly stallTimeoutMs: number = DAEMON_RPC_SOCKET_WRITE_STALL_TIMEOUT_MS,
  ) {}

  /**
   * Account for a frame about to be written. Returns undefined when it is
   * admitted, or the total queued bytes that would result when it must be
   * rejected. A frame onto an empty queue is always admitted.
   */
  admit(byteLength: number): number | undefined {
    const queued = this.socket.writableLength;
    if (queued === 0) {
      this.headEnd = this.admitted + byteLength;
    } else if (this.bytesBehindHead(queued) + byteLength > this.maxQueuedBytes) {
      return queued + byteLength;
    }
    this.admitted += byteLength;
    return undefined;
  }

  /** Call after `socket.write`; starts the stall watchdog for a large queue. */
  written(): void {
    if (this.socket.writableLength === 0) {
      this.clearWatchdog();
    } else if (!this.watchdog && this.socket.writableLength > this.stallWatchMinBytes) {
      this.armWatchdog();
    }
  }

  /** The queue emptied (`drain` or a write callback at zero). */
  flushed(): void {
    if (this.socket.writableLength === 0) {
      this.clearWatchdog();
    }
  }

  dispose(): void {
    this.clearWatchdog();
  }

  private get stallWatchMinBytes(): number {
    return Math.min(DAEMON_RPC_SOCKET_STALL_WATCH_MIN_BYTES, this.maxQueuedBytes);
  }

  private bytesBehindHead(queued: number): number {
    return Math.min(queued, Math.max(0, this.admitted - this.headEnd));
  }

  private armWatchdog(): void {
    this.drainedAtSample = this.admitted - this.socket.writableLength;
    this.watchdog = this.timer.setTimeout(() => this.checkProgress(), this.stallTimeoutMs);
  }

  private checkProgress(): void {
    this.watchdog = undefined;
    const queued = this.socket.writableLength;
    if (queued === 0) {
      return;
    }
    if (this.admitted - queued > this.drainedAtSample) {
      // Progress. Below the watch threshold the idle reaper takes over.
      if (queued > this.stallWatchMinBytes) {
        this.armWatchdog();
      }
      return;
    }
    this.onStalled({ queuedBytes: queued, stalledMs: this.stallTimeoutMs });
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      this.timer.clearTimeout(this.watchdog);
      this.watchdog = undefined;
    }
  }
}
