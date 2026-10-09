import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";

/**
 * Hands the `request_cancelled` result of a `provisionDevice` call whose caller aborted from the
 * tool handler to the daemon socket layer. The socket layer answers an abandoned request at once;
 * for `provisionDevice` it first waits (bounded) here so the abandoned-request reply carries the
 * handler's typed `request_cancelled` envelope and its `recovery` evidence instead of a generic
 * "daemon abandoned it" error (#11074).
 */
export class ProvisionCancellationOutcomes {
  private readonly waiters = new Map<string, Array<(outcome: unknown) => void>>();

  /** Called by the handler once it has built its cancellation result. */
  publish(operationId: string, outcome: unknown): void {
    const waiting = this.waiters.get(operationId);
    this.waiters.delete(operationId);
    waiting?.forEach((resolve) => resolve(outcome));
  }

  /** Whether a reply is currently waiting for this operation's outcome. */
  isAwaiting(operationId: string): boolean {
    return this.waiters.has(operationId);
  }

  /** Resolves with the published outcome, or undefined when none arrives within `timeoutMs`. */
  async await(operationId: string, timeoutMs: number, timer: Timer): Promise<unknown> {
    let resolveOutcome: (outcome: unknown) => void = () => {};
    const outcome = new Promise<unknown>((resolve) => {
      resolveOutcome = resolve;
    });
    this.waiters.set(operationId, [...(this.waiters.get(operationId) ?? []), resolveOutcome]);
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
      logger.debug(`provisionDevice ${operationId} cancellation outcome not received: ${error}`);
      return undefined;
    } finally {
      const rest = (this.waiters.get(operationId) ?? []).filter((w) => w !== resolveOutcome);
      if (rest.length > 0) {
        this.waiters.set(operationId, rest);
      } else {
        this.waiters.delete(operationId);
      }
    }
  }
}

export const provisionCancellationOutcomes = new ProvisionCancellationOutcomes();
