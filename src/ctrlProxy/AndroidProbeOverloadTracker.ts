import type { BackoffPolicy } from "../utils/Backoff";

export interface AndroidProbeOutcome {
  ready: boolean;
  connected: boolean;
  /** The probe used its whole timeout without an answer. */
  timedOut: boolean;
  nowMs: number;
}

export interface AndroidProbeOverloadOptions {
  backoff: BackoffPolicy;
  baseDelayMs: number;
  minConsecutiveTimeouts: number;
  failAfterRestartMs: number;
}

/**
 * Tracks the Android CtrlProxy overload signal during readiness polling
 * (#17813): a connected service whose probes keep timing out. Without that
 * signal the poll keeps its base cadence and never fails early, so a slow but
 * answering phone or emulator is unaffected. With it, probes back off and,
 * once the one process restart has run, a continuous overload of
 * `failAfterRestartMs` ends readiness early.
 */
export class AndroidProbeOverloadTracker {
  private consecutiveTimeouts = 0;
  private backoffAttempt = 0;
  private processRestarted = false;
  private overloadedSinceRestartMs: number | null = null;

  constructor(private readonly options: AndroidProbeOverloadOptions) {}

  get overloaded(): boolean {
    return this.consecutiveTimeouts >= this.options.minConsecutiveTimeouts;
  }

  recordProbe({ ready, connected, timedOut, nowMs }: AndroidProbeOutcome): void {
    if (ready || !connected || !timedOut) {
      this.clearOverload();
      return;
    }
    this.consecutiveTimeouts++;
    if (!this.overloaded) {
      return;
    }
    this.backoffAttempt++;
    if (this.processRestarted) {
      this.overloadedSinceRestartMs ??= nowMs;
    }
  }

  recordDisconnect(): void {
    this.clearOverload();
  }

  /** Only a restart that actually happened arms the fail-fast clock. */
  recordProcessRestart(): void {
    this.processRestarted = true;
    // The new process has to show the overload again before it counts.
    this.clearOverload();
  }

  retryDelayMs(): number {
    return this.overloaded
      ? this.options.backoff.delayForAttempt(this.backoffAttempt)
      : this.options.baseDelayMs;
  }

  shouldFailFast(nowMs: number): boolean {
    return (
      this.overloadedSinceRestartMs !== null &&
      nowMs - this.overloadedSinceRestartMs >= this.options.failAfterRestartMs
    );
  }

  private clearOverload(): void {
    this.consecutiveTimeouts = 0;
    this.backoffAttempt = 0;
    this.overloadedSinceRestartMs = null;
  }
}
