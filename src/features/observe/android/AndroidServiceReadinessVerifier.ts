/**
 * The CtrlProxy readiness probe (`verifyServiceReady`), extracted from `AndroidCtrlProxyClient`
 * (#11846). Behaviour is unchanged; the client exposes the hierarchy sync, retry executor and
 * logger it needs through {@link AndroidServiceReadinessContext}. `verifyServiceReady` stays a
 * public method on the client and delegates here.
 */
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import type { RetryExecutor } from "../../../utils/retry/RetryExecutor";
import { type Logger, logger } from "../../../utils/logger";
import type { AccessibilityHierarchy, AndroidPerfTiming, HierarchySyncDiagnostics } from "./types";

/**
 * verifyServiceReady stops retrying once the SAME correlated runner error text has been observed
 * on this many CONSECUTIVE verification attempts (issue #3097). A runner handler failure that
 * reproduces byte-identically after a retry delay is deterministic in practice — retrying to
 * exhaustion just burns the remaining `maxAttempts * (timeout + delay)` budget. Kept at 2 (not 1)
 * so a single handler error during service bring-up — where transient failures are expected —
 * always gets one retry before the loop concludes the failure is deterministic.
 */
export const VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT = 2;

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidServiceReadinessContext {
  readonly retryExecutor: RetryExecutor;
  /** The client's injected logger, used for the terminal warn. */
  readonly logger: Pick<Logger, "warn">;
  requestHierarchySync(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    diagnostics: HierarchySyncDiagnostics,
  ): Promise<{ hierarchy: AccessibilityHierarchy; perfTiming?: AndroidPerfTiming[] } | null>;
}

export class AndroidServiceReadinessVerifier {
  constructor(private readonly context: AndroidServiceReadinessContext) {}

  async verifyServiceReady(
    maxAttempts: number,
    delayMs: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const { context } = this;
    const signal = combineWithAmbientAbort();
    signal?.throwIfAborted();
    // Remember the most recent runner error text across attempts (issue #3062) so the terminal
    // warn — the one visible at the default log level — attributes the deterministic handler
    // failure, rather than collapsing every attempt into an anonymous "no hierarchy" (a runner
    // error and a plain timeout previously both surfaced identically here).
    let lastRunnerError: string | undefined;
    // Consecutive attempts that failed with byte-identical correlated runner error text
    // (issue #3097). A handler failure that reproduces verbatim after a retry delay is treated
    // as deterministic — the service will not become ready by retrying — so the loop stops
    // instead of burning the remaining attempts. Two safety valves protect the startup path
    // this method exists to verify (where a handler error CAN be transient during bring-up):
    // the first runner error always gets one retry, and a plain timeout in between resets the
    // streak (mixed signals are not evidence of determinism). Classifying specific runner
    // messages (allow/deny lists, structured codes) is deliberately avoided here: codes belong
    // in the runner's wire contract, and TS string-matching individual messages would be
    // fragile against runner text changes.
    let identicalRunnerErrorStreak = 0;
    let shortCircuited = false;
    const result = await context.retryExecutor.execute(
      async (attempt) => {
        logger.debug(`[CTRL_PROXY] Verifying service ready (attempt ${attempt}/${maxAttempts})`);

        const diagnostics: HierarchySyncDiagnostics = {};
        const hierarchyResult = await context.requestHierarchySync(signal, timeoutMs, diagnostics);

        if (hierarchyResult && hierarchyResult.hierarchy) {
          logger.debug(`[CTRL_PROXY] Service verified ready after ${attempt} attempt(s)`);
          return true;
        }

        if (diagnostics.runnerError) {
          identicalRunnerErrorStreak =
            diagnostics.runnerError === lastRunnerError ? identicalRunnerErrorStreak + 1 : 1;
          lastRunnerError = diagnostics.runnerError;
        } else {
          // A plain timeout breaks the deterministic-failure streak but keeps lastRunnerError,
          // so the terminal warn still attributes the most recent runner error.
          identicalRunnerErrorStreak = 0;
        }
        const runnerErrorSuffix = diagnostics.runnerError
          ? `: runner error: ${diagnostics.runnerError}`
          : "";
        throw new Error(
          `Verification attempt ${attempt} returned no hierarchy${runnerErrorSuffix}`,
        );
      },
      {
        maxAttempts,
        delays: delayMs,
        signal,
        shouldRetry: () => {
          if (identicalRunnerErrorStreak >= VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT) {
            shortCircuited = true;
            return false;
          }
          return true;
        },
        onRetry: (error, attempt) => {
          logger.debug(`[CTRL_PROXY] Verification attempt ${attempt} failed: ${error.message}`);
          logger.debug(`[CTRL_PROXY] Waiting ${delayMs}ms before next verification attempt`);
        },
      },
    );

    signal?.throwIfAborted();

    if (!result.success) {
      const runnerErrorSuffix = lastRunnerError ? ` (last runner error: ${lastRunnerError})` : "";
      const attemptsSummary = shortCircuited
        ? `${result.attempts}/${maxAttempts} verification attempts (short-circuited: identical runner error on ${VERIFY_READY_IDENTICAL_RUNNER_ERROR_LIMIT} consecutive attempts)`
        : `${maxAttempts} verification attempts`;
      context.logger.warn(
        `[CTRL_PROXY] Service not ready after ${attemptsSummary}${runnerErrorSuffix}`,
      );
      return false;
    }

    return result.value ?? false;
  }
}
