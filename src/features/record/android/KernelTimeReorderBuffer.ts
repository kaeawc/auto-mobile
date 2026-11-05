import type { Timer } from "../../../utils/SystemTimer";

export const DEFAULT_KERNEL_REORDER_WINDOW_MS = 50;

export interface KernelTimedLine {
  nodeKey: string;
  kernelMs?: number;
  line: string;
  arrivedAt: number;
}

interface PendingLine extends KernelTimedLine {
  kernelMs: number;
  releaseAt: number;
}

interface KernelTimeReorderBufferOptions {
  timer: Timer;
  windowMs?: number;
  onLine: (entry: KernelTimedLine) => void;
}

/** Merges node streams up to a bounded skew; emitted lines cannot be reordered retroactively. */
export class KernelTimeReorderBuffer {
  private pending: PendingLine[] = [];
  private maxSeenKernelMs = -Infinity;
  private releasePoint = -Infinity;
  private flushTimer?: NodeJS.Timeout;
  private flushAt?: number;
  private readonly windowMs: number;

  constructor(private readonly opts: KernelTimeReorderBufferOptions) {
    this.windowMs = opts.windowMs ?? DEFAULT_KERNEL_REORDER_WINDOW_MS;
    if (!Number.isFinite(this.windowMs) || this.windowMs < 0) {
      throw new RangeError("Kernel reorder window must be finite and non-negative");
    }
  }

  push(nodeKey: string, line: string, arrivedAt: number): void {
    const stamp = /^\[\s*(\d+(?:\.\d+)?)\s*\]/.exec(line);
    const kernelMs = stamp ? Number(stamp[1]) * 1000 : NaN;
    if (!Number.isFinite(kernelMs)) {
      this.opts.onLine({ nodeKey, line, arrivedAt });
      return;
    }
    this.maxSeenKernelMs = Math.max(this.maxSeenKernelMs, kernelMs);
    this.pending.push({
      nodeKey,
      kernelMs,
      line,
      arrivedAt,
      releaseAt: this.now() + this.windowMs,
    });
    // Array.sort is stable, so equal kernel stamps retain insertion order.
    this.pending.sort((a, b) => a.kernelMs - b.kernelMs);
    this.releaseThrough(Math.max(this.releasePoint, this.maxSeenKernelMs - this.windowMs));
    this.scheduleFlush();
  }

  /** Emit all pending lines in kernel order, retaining the release point for late arrivals. */
  drain(): void {
    this.cancelFlush();
    this.releaseThrough(this.maxSeenKernelMs);
  }

  /** Discard one node's queued lines while retaining the other nodes' deadlines. */
  dropNode(nodeKey: string): void {
    this.pending = this.pending.filter((entry) => entry.nodeKey !== nodeKey);
    this.scheduleFlush();
  }

  /** Drop pending lines without emitting, and reset this stream generation. */
  clear(): void {
    this.cancelFlush();
    this.pending = [];
    this.maxSeenKernelMs = -Infinity;
    this.releasePoint = -Infinity;
  }

  private releaseThrough(kernelMs: number): void {
    this.releasePoint = kernelMs;
    while (this.pending.length > 0 && this.pending[0].kernelMs <= kernelMs) {
      const entry = this.pending.shift()!;
      const { nodeKey, kernelMs: stamp, line, arrivedAt } = entry;
      this.opts.onLine({ nodeKey, kernelMs: stamp, line, arrivedAt });
    }
  }

  private scheduleFlush(): void {
    if (this.pending.length === 0) {
      this.cancelFlush();
      return;
    }
    let earliest = Infinity;
    for (const entry of this.pending) {
      earliest = Math.min(earliest, entry.releaseAt);
    }
    if (this.flushAt === earliest) {
      return;
    }
    this.cancelFlush();
    this.flushAt = earliest;
    this.flushTimer = this.opts.timer.setTimeout(
      () => {
        this.flushTimer = undefined;
        this.flushAt = undefined;
        const now = this.now();
        // Release the sorted prefix through every expired entry, including younger entries
        // with an earlier kernel stamp. This bounds latency without reversing pending lines.
        let through = this.releasePoint;
        for (const entry of this.pending) {
          if (entry.releaseAt <= now) {
            through = Math.max(through, entry.kernelMs);
          }
        }
        this.releaseThrough(through);
        this.scheduleFlush();
      },
      Math.max(0, earliest - this.now()),
    );
  }

  private cancelFlush(): void {
    if (this.flushTimer !== undefined) {
      this.opts.timer.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushAt = undefined;
  }

  private now(): number {
    return this.opts.timer.monotonicNow?.() ?? this.opts.timer.now();
  }
}
