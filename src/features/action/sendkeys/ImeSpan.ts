import { AsyncLocalStorage } from "node:async_hooks";
import type { SendKeysCommandExecutor } from "../SendKeys";
import type { ImeSubtypeSnapshot } from "../AndroidImeCatalog";
import { withAndroidImeLock, type AndroidImeRecoverySnapshot } from "../androidImeLock";
import { redactPasswordImeFailure, withImeFailure } from "../imeFailureDiagnostics";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

type SendKeysCommandExecution = Awaited<
  ReturnType<NonNullable<SendKeysCommandExecutor["withImeSpan"]>>
>;

export class ImeRestorationError extends Error {}

export function isImeRestorationFailure(error: unknown): boolean {
  return (
    error instanceof ImeRestorationError ||
    (error instanceof AggregateError &&
      error.errors.some((entry) => entry instanceof ImeRestorationError))
  );
}

export interface ImeSpanSnapshot {
  prior: string | null;
  wasEnabled: boolean;
  priorSubtype: ImeSubtypeSnapshot;
}

export interface AndroidImeSpan {
  snapshot?: ImeSpanSnapshot;
  lastType?: { text: string; focusedFieldClass?: string | null; passwordField?: boolean };
  safeToRestore: boolean;
  restorationFailed?: boolean;
  releaseLock?: () => void;
  lockCompletion?: Promise<void>;
}

export interface ImeSpanHost {
  deviceId: string;
  verifySafeImeRecovery(
    snapshot: AndroidImeRecoverySnapshot,
    signal?: AbortSignal,
  ): Promise<boolean>;
  restoreIme(
    prior: string | null,
    wasEnabled: boolean,
    priorSubtype: ImeSubtypeSnapshot,
  ): Promise<void>;
  clearPinnedUser(): void;
}

export class ImeSpanService {
  private readonly imeSpanContext = new AsyncLocalStorage<AndroidImeSpan>();

  constructor(private readonly host: ImeSpanHost) {}

  get imeSpan(): AndroidImeSpan | undefined {
    return this.imeSpanContext.getStore();
  }

  async withImeSpan(
    action: () => Promise<SendKeysCommandExecution>,
  ): Promise<SendKeysCommandExecution> {
    // Scope state to this call, including concurrent calls sharing this executor.
    return this.imeSpanContext.run({ safeToRestore: true }, () => this.finishImeSpan(action));
  }

  async acquireImeSpan(span: AndroidImeSpan, signal?: AbortSignal): Promise<void> {
    if (span.releaseLock) {
      return;
    }
    const admission = Promise.withResolvers<void>();
    const active = Promise.withResolvers<void>();
    // Keep the existing shared mutex callback alive until the loop's finally restores.
    // Acquire lazily so non-IME commands never inherit IME admission/quarantine failures.
    const completion = withAndroidImeLock(
      this.host.deviceId,
      async () => {
        span.releaseLock = active.resolve;
        admission.resolve();
        await active.promise;
      },
      signal,
      { recoverQuarantined: (snapshot) => this.host.verifySafeImeRecovery(snapshot, signal) },
    );
    void completion.catch(admission.reject);
    await admission.promise;
    span.lockCompletion = completion;
  }

  private async finishImeSpan(
    action: () => Promise<SendKeysCommandExecution>,
  ): Promise<SendKeysCommandExecution> {
    let execution: SendKeysCommandExecution | undefined;
    let failure: unknown;
    try {
      execution = await action();
    } catch (error) {
      logger.warn("[SendKeys] IME command span failed", error);
      failure = error;
    } finally {
      try {
        await this.restoreImeSpan();
      } catch (restoreError) {
        logger.warn("[SendKeys] IME span restoration failed", restoreError);
        if (failure !== undefined) {
          throw new AggregateError(
            [failure, restoreError],
            `${errorMessage(failure)}; ${errorMessage(restoreError)}`,
          );
        }
        this.reportImeSpanRestoreFailure(execution!, restoreError);
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
    execution!.restorationFailed = execution!.restorationFailed || this.imeSpan?.restorationFailed;
    return execution!;
  }

  private reportImeSpanRestoreFailure(
    execution: SendKeysCommandExecution,
    restoreError: unknown,
  ): void {
    // Prefer the IME-backed type whose commit needed the restore; a span whose types all
    // resolved elsewhere still reports the failure on the last command rather than crashing.
    const result =
      execution.results.findLast(
        (entry) =>
          entry.action === "type" &&
          (entry.resolvedMode === "ime" || entry.resolvedMode === "imeKeyEvents"),
      ) ?? execution.results.at(-1)!;
    result.error = result.success
      ? `Text commit succeeded, but ${errorMessage(restoreError)}`
      : `${result.error ?? "Text commit failed."} ${errorMessage(restoreError)}`;
    result.success = false;
    const lastType = this.imeSpan?.lastType;
    if (lastType && result.action === "type") {
      const failed = withImeFailure(result, lastType.text, "restoration", {
        focusedFieldClass: lastType.focusedFieldClass,
      });
      result.imeFailure = (
        lastType.passwordField ? redactPasswordImeFailure(failed, lastType.text) : failed
      ).imeFailure;
    }
    execution.failure = { index: result.index, error: result.error };
    execution.restorationFailed = true;
  }

  async restoreImeSpan(): Promise<void> {
    const span = this.imeSpan;
    if (!span) {
      return;
    }
    const snapshot = span.snapshot;
    // Consume the snapshot before cleanup so a failed restore is never retried implicitly.
    span.snapshot = undefined;
    try {
      if (snapshot && !span.safeToRestore) {
        const recovery =
          snapshot.prior === null
            ? 'run "keyboard listImes" and select an enabled IME, or restart the daemon.'
            : `run "keyboard setIme ${snapshot.prior}" or restart the daemon.`;
        throw new ImeRestorationError(
          `Original keyboard restoration was skipped after an unacknowledged cancellation; ${recovery}`,
        );
      }
      if (snapshot) {
        await this.host.restoreIme(snapshot.prior, snapshot.wasEnabled, snapshot.priorSubtype);
      }
    } catch (error) {
      span.restorationFailed = true;
      logger.warn("[SendKeys] Active IME span restoration failed", error);
      throw error;
    } finally {
      // Clear the pinned user before releasing the lock to another call on this executor.
      if (span.releaseLock) {
        this.host.clearPinnedUser();
      }
      span.releaseLock?.();
      span.releaseLock = undefined;
      await span.lockCompletion;
      span.lockCompletion = undefined;
    }
  }
}
