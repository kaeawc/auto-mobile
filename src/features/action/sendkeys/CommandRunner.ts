import { iosBackendFields } from "./IosSdkTextRouting";
import type { BootedDevice, ObserveResult } from "../../../models";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { withStaleDisplay } from "../../observe/StaleDisplayError";
import { beginPostActionCaptureAction } from "../../../utils/PostActionCaptureContext";
import type { ProgressCallback } from "../BaseVisualChange";
import { InputKey } from "../InputKey";
import { isImeRestorationFailure } from "./ImeSpan";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import {
  verifyPrototypeTextTarget,
  type PrototypeTextReading,
  type PrototypeTextTargetReader,
} from "../../prototype/prototypeTextTarget";
import { IME_COMMIT_READ_BACK_SETTLE_MS } from "./AndroidTypingConstants";
import { imeActionFailedAfterTextEntered } from "../imeActionFailedAfterTextEntered";
import { isSendKeysBudgetExhausted } from "./SendKeysRequestBudget";
import type { TargetState } from "./TargetState";
import type {
  SendKeysCommand,
  SendKeysCommandExecution,
  SendKeysCommandExecutor,
  SendKeysCommandResult,
  SendKeysFailure,
  SendKeysKey,
  SendKeysResult,
  SendKeysRouting,
  SendKeysSemanticKey,
} from "../SendKeys";

export interface CommandRunnerDeps {
  device: BootedDevice;
  adbFactory: AdbClientFactory;
  executor: SendKeysCommandExecutor;
  prototypeTextTarget: PrototypeTextTargetReader;
  timer: Timer;
  target: TargetState;
  isSemanticKey(key: SendKeysKey): key is SendKeysSemanticKey;
}

/**
 * Runs the validated command list: per-command prototype read-back, dispatch, failure guidance
 * and result assembly. Moved out of SendKeys unchanged (#11840).
 */
export class CommandRunner {
  constructor(private readonly deps: CommandRunnerDeps) {}

  checkBudgetCommandResult(result: SendKeysCommandResult, signal?: AbortSignal): void {
    if (isSendKeysBudgetExhausted(signal) && result.partialApplication && !result.success) {
      signal?.throwIfAborted();
    }
  }

  async readPrototypeBefore(
    command: SendKeysCommand,
    routing: SendKeysRouting,
    signal?: AbortSignal,
  ): Promise<PrototypeTextReading | undefined> {
    if (
      this.deps.target.effectiveLayer !== "prototype" ||
      command.action !== "type" ||
      !command.text ||
      this.deps.target.focusedPassword
    ) {
      return undefined;
    }
    try {
      return await this.deps.prototypeTextTarget.read(
        { identifiers: this.deps.target.prototypeIdentifiers, display: routing.display },
        signal,
      );
    } catch (error) {
      logger.warn("Prototype text before-read failed", error);
      signal?.throwIfAborted();
      return { kind: "unverifiable", reason: errorMessage(error) };
    }
  }

  async verifyPrototypeCommand(
    command: SendKeysCommand,
    result: SendKeysCommandResult,
    routing: SendKeysRouting,
    { signal, before }: { signal?: AbortSignal; before?: PrototypeTextReading } = {},
  ): Promise<SendKeysCommandResult> {
    if (
      this.deps.target.effectiveLayer !== "prototype" ||
      command.action !== "type" ||
      !command.text ||
      !result.success ||
      this.deps.target.focusedPassword ||
      this.deps.executor.isPasswordTarget?.()
    ) {
      return result;
    }
    const verification = await verifyPrototypeTextTarget({
      reader: this.deps.prototypeTextTarget,
      target: { identifiers: this.deps.target.prototypeIdentifiers, display: routing.display },
      text: command.text,
      operation: command.operation ?? "insert",
      timer: this.deps.timer,
      settleMs: IME_COMMIT_READ_BACK_SETTLE_MS,
      before,
      signal,
    });
    return {
      ...result,
      ...verification,
      ...(result.warning || verification.warning
        ? { warning: [result.warning, verification.warning].filter(Boolean).join(" ") }
        : {}),
    };
  }

  addImeFailureGuidance(
    command: SendKeysCommand,
    result: SendKeysCommandResult,
    completed: readonly SendKeysCommandResult[],
  ): void {
    if (
      !result.success &&
      command.action === "key" &&
      this.deps.isSemanticKey(command.key) &&
      completed.some((previous) => previous.action === "type" && previous.success)
    ) {
      result.error = imeActionFailedAfterTextEntered(command.key, result.error || "unknown error");
      logger.warn(`[SendKeys] ${result.error}`);
    }
  }

  buildResult(
    results: SendKeysCommandResult[],
    failure: SendKeysFailure | undefined,
    observation?: ObserveResult,
  ): SendKeysResult {
    const warnings = results.filter((result) => result.warning).map((result) => result.warning);
    if (failure) {
      const staleDisplay = results[failure.index]?.staleDisplay;
      return {
        success: false,
        completedCommands: results.filter((result) => result.success).length,
        failedIndex: failure.index,
        commands: results,
        observation,
        error: failure.error,
        ...(results[failure.index]?.retryable === false ? { retryable: false } : {}),
        ...(staleDisplay ? { staleDisplay } : {}),
        ...(warnings.length ? { warning: warnings.join(" ") } : {}),
      };
    }

    return {
      success: true,
      completedCommands: results.length,
      commands: results,
      observation,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  }

  async executeCommands(
    commands: SendKeysCommand[],
    progress?: ProgressCallback,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysCommandExecution> {
    const results: SendKeysCommandResult[] = [];
    const action = () =>
      this.executeCommandLoop(commands, progress, signal, {
        ...routing,
        onCommandResult: (result) => {
          results.push(result);
          routing.onCommandResult?.(result);
        },
      });
    // An auto/ime clear activates the IME the way IME typing does (#10479).
    const needsImeSpan = commands.some(
      (command) =>
        (command.action === "type" || command.action === "clear") &&
        ["auto", "ime", "imeKeyEvents"].includes(command.mode ?? "auto"),
    );
    try {
      return await (this.deps.device.platform === "android" &&
      needsImeSpan &&
      this.deps.executor.withImeSpan
        ? this.deps.executor.withImeSpan(action)
        : action());
    } catch (error) {
      if (!isImeRestorationFailure(error) || isSendKeysBudgetExhausted(signal)) {
        // Budget failures retain the delivery accounting in executeWithRequestBudget.
        throw error;
      }
      logger.warn("[SendKeys] Command execution and IME restoration failed", error);
      return {
        results,
        failure: { index: results.length, error: errorMessage(error) },
        restorationFailed: true,
      };
    }
  }

  async executeCommandLoop(
    commands: SendKeysCommand[],
    progress?: ProgressCallback,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysCommandExecution> {
    const results: SendKeysCommandResult[] = [];
    for (let index = 0; index < commands.length; index++) {
      signal?.throwIfAborted();
      await progress?.(index, commands.length, `Executing sendKeys command ${index + 1}`);
      const command = commands[index];
      if (!command) {
        continue;
      }
      const result = await this.executeCommandResult(command, index, signal, {
        routing,
        verifyEnter: this.needsEnterReadBack(command, commands[index + 1], results),
      });
      this.checkBudgetCommandResult(result, signal);
      result.index = index;
      this.addImeFailureGuidance(command, result, results);
      routing.onCommandResult?.(result);
      results.push(result);
      if (!result.success) {
        return {
          results,
          failure: {
            index,
            error: result.error ?? `sendKeys command ${index} failed`,
          },
        };
      }
    }
    return { results };
  }

  private needsEnterReadBack(
    command: SendKeysCommand,
    next: SendKeysCommand | undefined,
    completed: readonly SendKeysCommandResult[],
  ): boolean {
    if (this.deps.device.platform !== "android" || command.action !== "key") {
      return false;
    }
    if (!["enter", 66].includes(command.key) || command.modifiers?.length) {
      return false;
    }
    return (
      next?.action === "type" &&
      next.mode === "a11y" &&
      (next.operation ?? "insert") === "insert" &&
      next.text.length > 0 &&
      completed.some((result) => result.action === "type" && result.success)
    );
  }

  async executeCommandResult(
    command: SendKeysCommand,
    index: number,
    signal: AbortSignal | undefined,
    { routing, verifyEnter = false }: { routing: SendKeysRouting; verifyEnter?: boolean },
  ): Promise<SendKeysCommandResult> {
    try {
      routing.assertCurrent?.();
      // Command dispatches below bypass BaseVisualChange's action boundary.
      await beginPostActionCaptureAction();
      signal?.throwIfAborted();
      routing.onCommandStart?.();
      const before = await this.readPrototypeBefore(command, routing, signal);
      const action = () =>
        this.executeCommand(command, {
          signal,
          onDispatch: routing.onDispatch,
          displayId: routing.displayId,
          display: routing.display,
        });
      const result =
        verifyEnter && this.deps.executor.withEnterReadBack
          ? await this.deps.executor.withEnterReadBack(action, signal, routing.display)
          : await action();
      return this.verifyPrototypeCommand(command, result, routing, { signal, before });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[SendKeys] ${command.action} command ${index} failed`, error);
      return withStaleDisplay(
        {
          index,
          action: command.action,
          success: false,
          error: errorMessage(error),
        },
        error,
      );
    }
  }

  async executeCommand(
    command: SendKeysCommand,
    {
      signal,
      onDispatch,
      displayId,
      display,
    }: { signal?: AbortSignal; onDispatch?: () => void; displayId?: number; display?: string } = {},
  ): Promise<SendKeysCommandResult> {
    switch (command.action) {
      case "type":
        return this.deps.executor.type(command, signal, display);
      case "key":
        if (displayId !== undefined && !this.deps.isSemanticKey(command.key)) {
          this.deps.executor.resetCaretState?.();
          const result = await new InputKey(this.deps.device, {
            adbFactory: this.deps.adbFactory,
          }).press(command.key, undefined, undefined, {
            modifiers: command.modifiers,
            displayId,
            signal,
            onDispatch,
          });
          return {
            index: -1,
            action: "key",
            key: command.key,
            modifiers: command.modifiers,
            success: result.success,
            ...(result.error ? { error: result.error } : {}),
          };
        }
        return this.deps.executor.key(command, signal, onDispatch, display);
      case "clear":
        return this.deps.executor.clear(signal, display, command.mode).then((result) => ({
          index: -1,
          action: "clear",
          success: result.success,
          ...(result.partialApplication ? { partialApplication: true } : {}),
          ...(result.retryable === false ? { retryable: false } : {}),
          ...(result.warning === undefined ? {} : { warning: result.warning }),
          ...(result.error ? { error: result.error } : {}),
          ...iosBackendFields(result.iosBackend),
        }));
    }
  }
}
