import type { DecodedFrame } from "./frameProtocol";

/**
 * A one-slot queue for live video. Replacing an unread frame is intentional:
 * viewers need the newest image, not lossless history.
 */
export class LatestFrameQueue {
  private pending: QueuedFrame | null = null;
  private droppedFrames = 0;
  private highWaterMarkBytes = 0;
  private lastCaptureTimestampMs: number | null = null;

  constructor(
    private readonly options: {
      maxFrameBytes: number;
      now: () => number;
    },
  ) {}

  /**
   * Keeps the supplied frame only when it fits the fixed memory budget. A newer
   * frame always replaces an unread older one.
   */
  enqueue(frame: DecodedFrame): boolean {
    this.lastCaptureTimestampMs = frame.header.timestampMs;
    if (frame.pixels.length > this.options.maxFrameBytes) {
      this.droppedFrames++;
      return false;
    }
    if (this.pending !== null) {
      this.droppedFrames++;
    }
    this.pending = { frame, enqueuedAtMs: this.options.now() };
    this.highWaterMarkBytes = Math.max(this.highWaterMarkBytes, frame.pixels.length);
    return true;
  }

  take(): DecodedFrame | null {
    const queued = this.pending;
    this.pending = null;
    return queued?.frame ?? null;
  }

  clear(countPendingAsDropped = false): void {
    if (countPendingAsDropped && this.pending !== null) {
      this.droppedFrames++;
    }
    this.pending = null;
  }

  metrics(): FrameQueueMetrics {
    const pending = this.pending;
    return {
      captureTimestampMs: pending?.frame.header.timestampMs ?? this.lastCaptureTimestampMs,
      frameAgeMs: pending === null ? null : Math.max(0, this.options.now() - pending.enqueuedAtMs),
      queueDepth: pending === null ? 0 : 1,
      droppedFrames: this.droppedFrames,
      bytesQueued: pending?.frame.pixels.length ?? 0,
      highWaterMarkBytes: this.highWaterMarkBytes,
      maxFrameBytes: this.options.maxFrameBytes,
    };
  }
}

export interface FrameQueueMetrics {
  /** Capture time reported by the helper, relative to the helper start. */
  captureTimestampMs: number | null;
  /** Time a pending frame has spent waiting in this queue. */
  frameAgeMs: number | null;
  /** Always zero or one. */
  queueDepth: 0 | 1;
  droppedFrames: number;
  bytesQueued: number;
  highWaterMarkBytes: number;
  maxFrameBytes: number;
}

interface QueuedFrame {
  frame: DecodedFrame;
  enqueuedAtMs: number;
}
