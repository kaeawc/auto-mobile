import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

/** How long an outcome published before its waiter registered stays claimable (#11092). */
export const EARLY_OUTCOME_RETENTION_MS = 10_000;

/**
 * Hands the `request_cancelled` result of a `provisionDevice` call whose caller aborted from the
 * tool handler to the daemon socket layer. The socket layer answers an abandoned request at once;
 * for `provisionDevice` it first waits (bounded) here so the abandoned-request reply carries the
 * handler's typed `request_cancelled` envelope and its `recovery` evidence instead of a generic
 * "daemon abandoned it" error (#11074).
 *
 * Outcomes are keyed by the daemon-generated per-call key it forwards as
 * `__mcpLiveDeadlineKey`; provisionDevice has no caller-supplied id (#11065).
 */
export class ProvisionCancellationOutcomes {
  private readonly waiters = new Map<string, Array<(outcome: unknown) => void>>();
  private readonly early = new Map<string, { outcome: unknown; expiresAtMs: number }>();

  constructor(private readonly clock: Pick<Timer, "now"> = defaultTimer) {}

  /** Called by the handler once it has built its cancellation result. */
  publish(requestKey: string, outcome: unknown): void {
    const waiting = this.waiters.get(requestKey);
    this.waiters.delete(requestKey);
    if (!waiting || waiting.length === 0) {
      // The reply may not be waiting yet (a fast rollback): keep the outcome briefly.
      const now = this.clock.now();
      this.early.forEach((held, key) => {
        if (held.expiresAtMs <= now) {
          this.early.delete(key);
        }
      });
      this.early.set(requestKey, { outcome, expiresAtMs: now + EARLY_OUTCOME_RETENTION_MS });
      return;
    }
    waiting.forEach((resolve) => resolve(outcome));
  }

  /** Whether a reply is currently waiting for this call's outcome. */
  isAwaiting(requestKey: string): boolean {
    return this.waiters.has(requestKey);
  }

  /** Resolves with the published outcome, or undefined when none arrives within `timeoutMs`. */
  async await(requestKey: string, timeoutMs: number, timer: Timer): Promise<unknown> {
    const held = this.early.get(requestKey);
    if (held) {
      this.early.delete(requestKey);
      if (held.expiresAtMs > this.clock.now()) {
        return held.outcome;
      }
    }
    let resolveOutcome: (outcome: unknown) => void = () => {};
    const outcome = new Promise<unknown>((resolve) => {
      resolveOutcome = resolve;
    });
    this.waiters.set(requestKey, [...(this.waiters.get(requestKey) ?? []), resolveOutcome]);
    try {
      return await raceWithDeadline(outcome, {
        timer,
        timeoutMs,
        label: "provisionDevice cancellation outcome",
        timeoutError: () => new Error("no cancellation outcome"),
      });
    } catch (error) {
      // Timing out is expected when the handler is slower than the bounded wait: the caller then
      // gets the generic abandonment reply, exactly as before.
      logger.debug(`provisionDevice ${requestKey} cancellation outcome not received: ${error}`);
      return undefined;
    } finally {
      const rest = (this.waiters.get(requestKey) ?? []).filter((w) => w !== resolveOutcome);
      if (rest.length > 0) {
        this.waiters.set(requestKey, rest);
      } else {
        this.waiters.delete(requestKey);
      }
    }
  }
}

export const provisionCancellationOutcomes = new ProvisionCancellationOutcomes();
