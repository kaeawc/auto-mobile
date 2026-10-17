/**
 * Represents a single timing entry in the performance data
 */
export interface TimingEntry {
  name: string;
  durationMs: number;
  children?: TimingData;
}

/**
 * Timing data structure:
 * - Array = serial operations (ordered execution)
 * - Object = parallel operations (concurrent execution)
 */
export type TimingData = TimingEntry[] | Record<string, TimingEntry>;
