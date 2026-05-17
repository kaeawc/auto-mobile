import type {
  AnrEvent,
  CrashEvent,
  CrashEventSink,
} from "../../src/utils/interfaces/CrashMonitor";

/**
 * In-memory fake implementation of CrashEventSink for tests.
 *
 * Captures every crash/ANR event passed to it so tests can assert on what
 * AndroidCtrlProxyClient (or any other sink consumer) persisted, without
 * touching the database.
 */
export class FakeCrashEventSink implements CrashEventSink {
  public readonly savedCrashes: CrashEvent[] = [];
  public readonly savedAnrs: AnrEvent[] = [];

  private nextCrashId = 1;
  private nextAnrId = 1;
  private shouldThrow: Error | null = null;

  /**
   * Force the next save call (crash or ANR) to reject with the given error.
   * Auto-clears after one throw so subsequent saves succeed unless re-armed.
   */
  failNextSaveWith(error: Error): void {
    this.shouldThrow = error;
  }

  async saveCrash(event: CrashEvent): Promise<number> {
    this.maybeThrow();
    this.savedCrashes.push(event);
    return this.nextCrashId++;
  }

  async saveAnr(event: AnrEvent): Promise<number> {
    this.maybeThrow();
    this.savedAnrs.push(event);
    return this.nextAnrId++;
  }

  reset(): void {
    this.savedCrashes.length = 0;
    this.savedAnrs.length = 0;
    this.nextCrashId = 1;
    this.nextAnrId = 1;
    this.shouldThrow = null;
  }

  private maybeThrow(): void {
    if (this.shouldThrow) {
      const error = this.shouldThrow;
      this.shouldThrow = null;
      throw error;
    }
  }
}
