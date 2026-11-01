import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { combineAbortSignals, getRequestContext } from "../../../utils/AbortContext";
import type { Timer } from "../../../utils/SystemTimer";
import { TEXT_MCP_REQUEST_HEADROOM_MS, getTextRequestDeadlineMs } from "../textTransportTimeout";
import type { ProgressCallback } from "../BaseVisualChange";
import { isImeRestorationFailure } from "./ImeSpan";
import type {
  SendKeysCommand,
  SendKeysCommandResult,
  SendKeysResult,
  SendKeysRouting,
  SendKeysSelector,
  SendKeysSemanticKey,
} from "../SendKeys";

import { SendKeysBudgetError } from "./SendKeysBudgetError";

export function isSendKeysBudgetExhausted(signal?: AbortSignal): boolean {
  return signal?.aborted === true && signal.reason instanceof SendKeysBudgetError;
}

/** Context for the bounded iOS IME interaction, after the commands and the semantic key. */
export interface BoundedIosImeOptions {
  selector?: SendKeysSelector;
  progress?: ProgressCallback;
  signal?: AbortSignal;
  target: Pick<SendKeysRouting, "display" | "assertCurrent" | "container" | "selectionStrategy">;
}

export interface SendKeysRequestBudgetDeps {
  platform(): string;
  timer: Timer;
  executeUnbounded(
    commands: SendKeysCommand[],
    selector?: SendKeysSelector,
    progress?: ProgressCallback,
    routing?: SendKeysRouting & { signal?: AbortSignal },
  ): Promise<SendKeysResult>;
}

/**
 * The Android request budget (abort before the MCP request deadline, report a partial result) and
 * the bounded iOS IME interaction. Moved out of SendKeys unchanged (#11840).
 */
export class SendKeysRequestBudget {
  constructor(private readonly deps: SendKeysRequestBudgetDeps) {}

  async executeWithRequestBudget(
    commands: SendKeysCommand[],
    options: {
      selector?: SendKeysSelector;
      progress?: ProgressCallback;
      signal?: AbortSignal;
      routing: SendKeysRouting;
    },
  ): Promise<SendKeysResult> {
    const { selector, progress, signal, routing } = options;
    // Capture the live accessor while request context is active; timers may run outside it.
    const getDeadlineMs = getRequestContext()?.getDeadlineMs;
    const deadlineMs = getTextRequestDeadlineMs(getDeadlineMs);
    if (this.deps.platform() !== "android" || deadlineMs === undefined) {
      return this.deps.executeUnbounded(commands, selector, progress, { signal, ...routing });
    }
    const controller = new AbortController();
    const remainingMs = deadlineMs - this.deps.timer.now() - TEXT_MCP_REQUEST_HEADROOM_MS;
    let handle: NodeJS.Timeout | undefined;
    const expireOrRearm = () => {
      const liveRemainingMs =
        (getTextRequestDeadlineMs(getDeadlineMs) ?? deadlineMs) -
        this.deps.timer.now() -
        TEXT_MCP_REQUEST_HEADROOM_MS;
      if (liveRemainingMs > 0) {
        handle = this.deps.timer.setTimeout(expireOrRearm, liveRemainingMs);
      } else {
        controller.abort(new SendKeysBudgetError());
      }
    };
    expireOrRearm();
    const combined = combineAbortSignals(signal, controller.signal);
    const results: SendKeysCommandResult[] = [];
    let pending = false;
    try {
      return await this.deps.executeUnbounded(commands, selector, progress, {
        signal: combined,
        ...routing,
        onCommandStart: () => {
          pending = true;
        },
        onCommandResult: (result) => {
          pending = false;
          results.push(result);
        },
      });
    } catch (error) {
      if (!isImeRestorationFailure(error)) {
        signal?.throwIfAborted();
      }
      if (!isSendKeysBudgetExhausted(combined)) {
        // Preserve the same error identity as the no-deadline path.
        throw error;
      }
      logger.warn("[SendKeys] Request budget exhausted", error);
      const result = this.budgetResult(commands.length, results, pending, remainingMs <= 0);
      if (isImeRestorationFailure(error)) {
        result.success = false;
        result.error = `${result.error ?? "Text commit succeeded, but"} ${errorMessage(error)}`;
      }
      return result;
    } finally {
      if (handle !== undefined) {
        this.deps.timer.clearTimeout(handle);
      }
    }
  }

  budgetResult(
    commandCount: number,
    results: SendKeysCommandResult[],
    indeterminate: boolean,
    refusedAtAdmission: boolean,
  ): SendKeysResult {
    const completedCommands = results.filter((result) => result.success).length;
    const warnings = results.flatMap((result) => (result.warning ? [result.warning] : []));
    if (completedCommands === commandCount) {
      return {
        success: true,
        completedCommands,
        commands: results,
        warning: [
          ...warnings,
          "All commands were delivered; the request budget expired before final observation completed.",
        ].join(" "),
      };
    }
    const firstUnconfirmed = results.length;
    const notSent = commandCount - firstUnconfirmed - (indeterminate ? 1 : 0);
    const error =
      `sendKeys request budget exhausted: ${completedCommands} command(s) delivered; ` +
      `${notSent} command(s) not sent.` +
      (indeterminate
        ? ` Command ${firstUnconfirmed} outcome is indeterminate: it may have been sent but was not acknowledged. Do not retry automatically; observe before retrying.`
        : refusedAtAdmission
          ? " no request budget remained at admission; no commands were sent."
          : " No further commands were dispatched.");
    return {
      success: false,
      completedCommands,
      failedIndex: firstUnconfirmed,
      commands: results,
      error,
      warning: [
        ...warnings,
        "Partial application: already delivered commands are not rolled back.",
      ].join(" "),
      retryable: false,
    };
  }

  async executeBoundedIosIme(
    commands: SendKeysCommand[],
    key: SendKeysSemanticKey,
    options: BoundedIosImeOptions,
  ): Promise<SendKeysResult> {
    const { selector, progress, signal, target } = options;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    let dispatched = false;
    let actionResult: SendKeysCommandResult | undefined;
    const deadline = Symbol("IME action deadline");
    let interaction!: Promise<SendKeysResult>;
    const startInteraction = () =>
      (interaction = this.deps.executeUnbounded(commands, selector, progress, {
        signal: controller.signal,
        onDispatch: () => {
          dispatched = true;
        },
        onCommandResult: (result) => {
          actionResult = result;
        },
        ...target,
      }));
    try {
      try {
        return await raceWithDeadline(startInteraction, {
          timer: this.deps.timer,
          timeoutMs: 5000,
          label: "iOS IME interaction",
          timeoutError: () => deadline,
        });
      } catch (error) {
        if (error !== deadline) {
          throw error;
        }
      }
      controller.abort();
      void interaction.catch((error) => {
        // The timed-out interaction can still settle while the connection recovers.
        logger.debug(
          `[SendKeys] iOS IME interaction settled after deadline: ${errorMessage(error)}`,
        );
      });
      if (actionResult) {
        return {
          success: actionResult.success,
          completedCommands: actionResult.success ? 1 : 0,
          ...(!actionResult.success ? { failedIndex: 0, error: actionResult.error } : {}),
          commands: [actionResult],
          ...(actionResult.success
            ? {
                warning:
                  "Post-action observation did not complete within 5000ms; the IME action was already applied.",
              }
            : {}),
        };
      }
      const error = dispatched
        ? `IME action '${key}' outcome is indeterminate: the request was dispatched but no result was received within 5000ms. Do not retry automatically.`
        : `IME action '${key}' timed out before dispatch after 5000ms.`;
      return {
        success: false,
        completedCommands: 0,
        failedIndex: 0,
        commands: [{ index: 0, action: "key", key, success: false, error, retryable: !dispatched }],
        error,
        retryable: !dispatched,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
