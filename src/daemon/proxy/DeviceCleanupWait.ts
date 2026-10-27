import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { exponentialBackoff, normalizeBackoff, type BackoffInput } from "../../utils/Backoff";
import type { Timer } from "../../utils/SystemTimer";
import { readToolEnvelopePayload } from "../../utils/toolEnvelopePayload";
import { DEVICE_CLEANUP_IN_PROGRESS_CODE } from "../../models/deviceAcquisitionRefusals";
import type { ForwardedToolCall } from "./ToolCallForwarder";

/**
 * Longest a bind waits out a `device_cleanup_in_progress` refusal: the recording-finalize cap
 * (about 120 s, #10957) plus slack for the restores around it. Shared with the JUnit runner and
 * XCTestRunner through `finalizeWait.waitBudgetMs` in `test/fixtures/refusal-wire-hints/hints.json`
 * (#11360): change them together.
 */
export const DEVICE_CLEANUP_WAIT_BUDGET_MS = 150_000;

/** Short growing polls notice early cleanup; its remaining-cap hint is an upper bound (#11900). */
const DEVICE_CLEANUP_BACKOFF = exponentialBackoff({
  initialDelayMs: 250,
  multiplier: 2,
  maxDelayMs: 5_000,
});

/** A hint or backoff near zero must not busy-poll the daemon (#11900). */
const DEVICE_CLEANUP_POLL_FLOOR_MS = 50;

/** What the wait needs from its proxy: whether it is closing, and a re-forward of the refused bind. */
export interface DeviceCleanupWaitPort {
  isClosing(): boolean;
  /** Forward the refused call again, without the suspect-session retry. */
  reforward(): Promise<ForwardedToolCall>;
  /** The `device_cleanup_in_progress` refusal in a result, if any (supplied by the proxy). */
  readCleanupRefusal(result: unknown): { retryAfterMs?: number } | undefined;
}

export interface DeviceCleanupWaitDeps {
  timer: Timer;
  budgetMs?: number;
  backoff?: BackoffInput;
}

/**
 * A bind refused as `device_cleanup_in_progress` never reached a device, so it is forwarded
 * again on short growing polls while the previous session's cleanup settles (#11900). The wait is
 * bounded by the cleanup budget; when it runs out the last refusal is returned unchanged.
 */
export class DeviceCleanupWait {
  constructor(private readonly deps: DeviceCleanupWaitDeps) {}

  async waitOut(
    first: ForwardedToolCall,
    name: string,
    port: DeviceCleanupWaitPort,
    signal: AbortSignal | undefined,
  ): Promise<ForwardedToolCall> {
    const { timer } = this.deps;
    const budgetMs = this.deps.budgetMs ?? DEVICE_CLEANUP_WAIT_BUDGET_MS;
    const deadline = timer.now() + budgetMs;
    const backoff = normalizeBackoff(this.deps.backoff ?? DEVICE_CLEANUP_BACKOFF);
    let current = first;
    for (let attempt = 1; !port.isClosing(); attempt++) {
      const refusal = port.readCleanupRefusal(current.result);
      const remaining = deadline - timer.now();
      if (!refusal || remaining <= 0) {
        return current;
      }
      const backoffMs = backoff.delayForAttempt(attempt);
      const hintMs = refusal.retryAfterMs;
      const cleanupCap =
        readToolEnvelopePayload(current.result)?.payload.code === DEVICE_CLEANUP_IN_PROGRESS_CODE;
      const stepMs = Math.max(
        DEVICE_CLEANUP_POLL_FLOOR_MS,
        hintMs !== undefined && hintMs > 0
          ? cleanupCap
            ? Math.min(hintMs, backoffMs)
            : Math.max(hintMs, backoffMs)
          : backoffMs,
      );
      const delayMs = Math.floor(Math.min(remaining, stepMs));
      if (delayMs <= 0) {
        return current;
      }
      logger.info(
        `[DaemonMcpProxy] ${name} refused while the device finishes its previous session's cleanup; re-checking in ${delayMs}ms`,
      );
      await this.waitForPoll(delayMs, signal);
      current = await port.reforward();
    }
    return current;
  }

  /** Keep the poll timeout cancellable; raceWithDeadline owns and removes the abort listener. */
  private async waitForPoll(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    const { timer } = this.deps;
    let handle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            handle = timer.setTimeout(resolve, delayMs);
          }),
        { timer, signal, label: "Device cleanup wait" },
      );
    } finally {
      if (handle !== undefined) {
        timer.clearTimeout(handle);
      }
    }
  }
}
