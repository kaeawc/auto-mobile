import type { TimingData, TimingEntry } from "../models/TimingData";
import type { PerformanceTracker, TimingBlock } from "./PerformanceTracker";

/**
 * No-op implementation for when performance tracking is disabled
 * All methods are essentially pass-through with minimal overhead
 */
export class NoOpPerformanceTracker implements PerformanceTracker {
  private root: TimingBlock = {
    name: "noop",
    type: "serial",
    startMs: 0,
    entries: [],
    parent: null,
  };
  private current: TimingBlock = this.root;
  private operationStarts: Map<string, number> = new Map();

  serial(_name: string): PerformanceTracker {
    return this;
  }

  parallel(_name: string): PerformanceTracker {
    return this;
  }

  async track<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  trackSync<T>(_name: string, fn: () => T): T {
    return fn();
  }

  end(): PerformanceTracker {
    return this;
  }

  getTimings(): TimingData | null {
    return null;
  }

  isEnabled(): boolean {
    return false;
  }

  addExternalTiming(_name: string, _entry: TimingEntry | TimingEntry[]): void {
    // No-op
  }

  startOperation(_name: string): void {
    // No-op
  }

  endOperation(_name: string): void {
    // No-op
  }

  fork(): PerformanceTracker {
    // No state to isolate -- every method above is already a pass-through.
    return this;
  }
}
