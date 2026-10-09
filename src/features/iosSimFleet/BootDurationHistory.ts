import type { BootDurationSample } from "./types";

const DEFAULT_MAX_SAMPLES = 200;

/** Where boot-to-ready durations are recorded so configurations can be compared. */
export interface BootDurationHistory {
  record(sample: BootDurationSample): void;
  /** Most recent sample for a simulator, if one was recorded. */
  latestFor(udid: string): BootDurationSample | undefined;
  /** Most recent samples for a profile, newest first. */
  recentForProfile(profileId: string, limit?: number): BootDurationSample[];
}

/** Bounded process-local history; the oldest samples are dropped first. */
export class InMemoryBootDurationHistory implements BootDurationHistory {
  private samples: BootDurationSample[] = [];

  constructor(private readonly maxSamples: number = DEFAULT_MAX_SAMPLES) {}

  record(sample: BootDurationSample): void {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) {
      return; // a missing or negative duration must not look like a fast boot
    }
    this.samples = [...this.samples, sample].slice(-this.maxSamples);
  }

  latestFor(udid: string): BootDurationSample | undefined {
    return this.samples.findLast((sample) => sample.udid === udid);
  }

  recentForProfile(profileId: string, limit: number = 10): BootDurationSample[] {
    return this.samples
      .filter((sample) => sample.profileId === profileId)
      .slice(-limit)
      .reverse();
  }
}
