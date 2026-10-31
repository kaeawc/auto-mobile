import { ActionableError, toActionableError } from "../models";
import { isAndroidFrameworkUnavailable } from "../utils/android-cmdline-tools/isAndroidFrameworkUnavailable";
import { runWithAbortSignal } from "../utils/AbortContext";
import type { AdjustableDeadline } from "../utils/AdjustableDeadline";
import { trackAmbient } from "../utils/PerfContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { runPhaseWithSettlement } from "../utils/runPhaseWithSettlement";
import type { Timer } from "../utils/SystemTimer";
import type {
  ReadinessAttemptContext,
  RunnerReadinessPhase,
} from "./RunnerReadinessAttemptContext";
import { RunnerReadinessError } from "./RunnerReadinessError";
import { isForegroundUserPending } from "./setupUser";
import { normalizeDiagnostic, phaseElapsedLabel } from "./runnerReadinessDiagnosticText";

export const READINESS_PROBE_TIMEOUT_MS = 2_000;
const ABORT_SETTLEMENT_GRACE_MS = 1_000;

/**
 * Phase deadline accounting, bounded phase execution and failure construction
 * for one runner readiness request.
 */
export class ReadinessPhaseRunner {
  constructor(private readonly timer: Timer) {}

  throwIfCallerCancelled(context: ReadinessAttemptContext, fallback?: unknown): void {
    if (context.signal?.aborted) {
      if (context.deadlineFailure) {
        throw context.deadlineFailure;
      }
      throw context.signal.reason ?? fallback ?? new Error("System UI ANR recovery cancelled");
    }
  }

  async runPhase<T>(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
    attempts: number,
    {
      operation,
      operationDeadlineMs,
    }: { operation: (signal: AbortSignal) => Promise<T>; operationDeadlineMs?: number },
  ): Promise<T> {
    const remainingMs = Math.min(
      this.remainingForPhase(context, phase),
      operationDeadlineMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, operationDeadlineMs - this.timer.now()),
    );
    if (remainingMs <= 0) {
      this.fail(context, phase, attempts, {
        detail: "readiness budget exhausted before phase started",
        deadlineExhausted: true,
      });
    }
    let phaseTimedOut = false;
    let operationFailure: unknown;
    let callerTimedOut = false;
    const recordCallerAbort = () => {
      callerTimedOut = this.timer.now() >= this.totalDeadlineMs(context);
    };
    context.signal?.addEventListener("abort", recordCallerAbort, { once: true });
    if (context.signal?.aborted) {
      recordCallerAbort();
    }
    const deadlineError = () => {
      const stage =
        phase === "runner-connect"
          ? "CtrlProxy WebSocket connect"
          : phase === "runner-health"
            ? "CtrlProxy readiness wait"
            : context.device.platform === "ios"
              ? "iOS CtrlProxy setup"
              : "CtrlProxy package/setup";
      return new ActionableError(
        `${stage} timed out: readiness phase exceeded the remaining deadline. Retry device acquisition.`,
      );
    };
    const callerAbortError = (reason: unknown) =>
      callerTimedOut
        ? operationFailure === undefined
          ? deadlineError()
          : toActionableError(operationFailure, `Runner readiness ${phase} failed`)
        : reason;
    const phaseStartedMs = this.timer.now();
    let elapsedRecorded = false;
    const recordElapsed = (): void => {
      if (elapsedRecorded) {
        return;
      }
      elapsedRecorded = true;
      const elapsedMs = Math.max(0, this.timer.now() - phaseStartedMs);
      context.phaseElapsedMs[phase] = (context.phaseElapsedMs[phase] ?? 0) + elapsedMs;
    };
    // Record one `readiness:<phase>` span. The ambient tracker is already
    // established for the whole attempt in `ensureReadyUncoordinated`, so the
    // runner install/start/health commands (adb, simctl, xcodebuild) beneath
    // this phase attribute their time here (see PerfContext); `trackAmbient` is
    // a no-op when no ambient tracker is in scope.
    try {
      return await runPhaseWithSettlement(
        {
          timer: this.timer,
          timeoutMs: remainingMs,
          deadline: ReadinessPhaseRunner.movableDeadline(context, phase, operationDeadlineMs),
          signal: context.signal,
          graceMs: ABORT_SETTLEMENT_GRACE_MS,
          label: `Runner readiness ${phase}`,
          preferOperationFailureOnTimeout: true,
          explicitAbortError: callerAbortError,
          defaultAbortError: () => callerAbortError(context.signal?.reason),
          timeoutError: () => {
            phaseTimedOut = true;
            return deadlineError();
          },
          onRaceSettled: recordElapsed,
        },
        async (signal) => {
          try {
            return await trackAmbient(`readiness:${phase}`, () =>
              runWithAbortSignal(signal, () => operation(signal)),
            );
          } catch (error) {
            operationFailure = error;
            throw error;
          }
        },
      );
    } catch (error) {
      // Capture the phase duration at the deadline, excluding any grace period
      // spent waiting for an aborted platform command to settle.
      recordElapsed();
      if (!callerTimedOut) {
        this.throwIfCallerCancelled(context, error);
      }
      // An operation fault remains a fault; only the owned deadline or a
      // request abort captured at that deadline is a timeout.
      return this.fail(context, phase, attempts, {
        detail: error,
        deadlineExhausted: phaseTimedOut || callerTimedOut,
      });
    } finally {
      context.signal?.removeEventListener("abort", recordCallerAbort);
      recordElapsed();
    }
  }

  async awaitAbortSettlement(operation: Promise<unknown>): Promise<void> {
    const timedOut = new Error("Abort settlement grace expired");
    try {
      await raceWithDeadline(
        operation.then(
          () => undefined,
          () => undefined,
        ),
        {
          timer: this.timer,
          timeoutMs: ABORT_SETTLEMENT_GRACE_MS,
          label: "Abort settlement grace",
          timeoutError: () => timedOut,
        },
      );
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
    }
  }

  probeTimeout(context: ReadinessAttemptContext): number {
    return Math.max(
      1,
      Math.min(READINESS_PROBE_TIMEOUT_MS, this.remainingForPhase(context, "runner-health")),
    );
  }

  /**
   * Setup/provision phases (a cold CtrlProxy download + `xcodebuild`/install
   * launch) are the ones that legitimately take boot-class time, so they run
   * against `totalDeadlineMs`. Connect/health probes are steady-state and stay
   * fast-fail against the health window (#5376).
   */
  private static isSetupPhase(phase: RunnerReadinessPhase): boolean {
    return phase === "runner-setup" || phase === "package-compatibility";
  }

  /** Only a setup phase bounded by the movable total deadline itself follows its moves. */
  private static movableDeadline(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
    operationDeadlineMs: number | undefined,
  ): AdjustableDeadline | undefined {
    return operationDeadlineMs === undefined && ReadinessPhaseRunner.isSetupPhase(phase)
      ? context.deadline
      : undefined;
  }

  /** The request's total deadline, following a movable deadline when the caller supplied one. */
  private totalDeadlineMs(context: ReadinessAttemptContext): number {
    return context.deadline?.deadlineMs ?? context.totalDeadlineMs;
  }

  private phaseDeadlineMs(context: ReadinessAttemptContext, phase: RunnerReadinessPhase): number {
    if (ReadinessPhaseRunner.isSetupPhase(phase)) {
      return this.totalDeadlineMs(context);
    }
    // Before the health window opens (fast-path probes run before setup), fall
    // back to the total deadline; those probes self-bound via `probeTimeout`.
    return context.healthDeadlineMs ?? this.totalDeadlineMs(context);
  }

  remainingForPhase(context: ReadinessAttemptContext, phase: RunnerReadinessPhase): number {
    return Math.max(0, this.phaseDeadlineMs(context, phase) - this.timer.now());
  }

  /**
   * Open the steady-state connect/health window once provisioning is done, so a
   * long cold launch does not eat the health budget. Still bounded by the
   * caller's total deadline (#5376).
   */
  startHealthWindow(context: ReadinessAttemptContext): void {
    if (context.healthDeadlineMs !== null) {
      return;
    }
    context.healthDeadlineMs = Math.min(
      this.totalDeadlineMs(context),
      this.timer.now() + context.readinessTimeoutMs,
    );
  }

  /**
   * Report a readiness failure. `deadlineExhausted` says the phase ran out of
   * BUDGET, so callers may treat it as a retryable timeout -- it must be stated
   * by the caller, never inferred from the remaining budget at throw time: a
   * terminal platform fault (runner not installed, version mismatch, a setup
   * error, an orphaned forwarding lease) that happens to land as the phase
   * deadline passes would otherwise be mapped to a retryable `timeout` and
   * retried forever.
   */
  fail(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
    attempts: number,
    {
      detail,
      ...options
    }: {
      detail: unknown;
      deadlineExhausted?: boolean;
      failureKind?: "ctrlproxy_forward_unavailable";
      previousAttemptDetails?: readonly string[];
    },
  ): never {
    const { device } = context;
    const mapping =
      `platform=${device.platform} requested=[${context.requestedIdentity}] ` +
      `resolved=[${device.name} (${device.deviceId})]`;
    const remainingBudgetMs = this.remainingForPhase(context, phase);
    const phaseElapsed = Object.entries(context.phaseElapsedMs)
      .map(([trackedPhase, elapsedMs]) => `${phaseElapsedLabel(trackedPhase)}=${elapsedMs}`)
      .join(" ");
    const readinessContext =
      `${context.operationName ?? "startDevice"} automation runner readiness failed: ${mapping} phase=${phase} ` +
      `attempts=${attempts} remainingBudgetMs=${remainingBudgetMs}${phaseElapsed ? ` ${phaseElapsed}` : ""}`;
    const detailMessage = [
      normalizeDiagnostic(detail),
      ...(options.previousAttemptDetails ?? []),
    ].join("; ");
    const failure = new RunnerReadinessError(
      options.failureKind
        ? `${detailMessage}; ${readinessContext}`
        : `${readinessContext}: ${detailMessage}`,
      {
        retryableAndroidFrameworkFailure:
          device.platform === "android" &&
          ReadinessPhaseRunner.isSetupPhase(phase) &&
          (isAndroidFrameworkUnavailable(detail) || isForegroundUserPending(detail)),
        deadlineExhausted: options.deadlineExhausted ?? false,
        phase,
        attempts,
        diagnosticCause: detail,
        failureKind: options.failureKind,
      },
    );
    if (options.deadlineExhausted) {
      context.deadlineFailure = failure;
    }
    throw failure;
  }
}
