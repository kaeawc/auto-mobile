import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import type { Timer } from "../../../utils/SystemTimer";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import {
  explainIosIndeterminateText,
  readIosTypedTextField,
  readIosTypedTextFocus,
  verifyIosTypedText,
  type IosTypedTextRead,
  type IosTypedTextVerificationOptions,
} from "../iosTypedTextVerification";
import {
  assessIosTextToolBudget,
  getTextRequestDeadlineMs,
  resolveTextCtrlProxyTimeoutMs,
} from "../textTransportTimeout";
import { isTextIndeterminateMessage } from "../TextIndeterminateError";
import { splitIosTextChunks } from "./IosTextChunks";
import type { FocusedTextField } from "../ClearText";
import type { TypingSession } from "./TypingSession";
import type {
  ResolvedSendKeysTypingMode,
  SendKeysObserver,
  SendKeysOperation,
  SendKeysTextClient,
  TextActionResult,
} from "../SendKeys";

interface IosChunkRead extends IosTypedTextRead {
  deadlineMs: number | undefined;
  verification?: IosTypedTextVerificationOptions;
}

interface IosTypingPreparation {
  before: FocusedTextField | undefined;
  clearWarning: string | undefined;
}

export interface IosTyperDeps {
  session: TypingSession;
  observer: SendKeysObserver;
  timer: Timer;
  targetLayer(): HierarchyLayer | undefined;
  willAssignWebValue?(): boolean;
  assignsWebValue?(): boolean;
  clear(signal?: AbortSignal, display?: string): Promise<TextActionResult>;
  insert: SendKeysTextClient["insert"];
  withTextWarnings(result: TextActionResult, warnings: Array<string | undefined>): TextActionResult;
  markPartialAfterMutation(result: TextActionResult): TextActionResult;
}

/**
 * The iOS typing path: bounded XCUITest appends with one optional replace-clear and
 * read-back verification after each chunk.
 */
export class IosTyper {
  constructor(private readonly deps: IosTyperDeps) {}

  async executeIosType(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    signal?.throwIfAborted();
    const resolvedMode = "xcuiTypeText" as const;
    const chunks = splitIosTextChunks(text);
    const codePoints = Array.from(text).length;
    const predictedWebAssignment = operation === "replace" && this.deps.willAssignWebValue?.();
    const budget = this.assessTypingBudget(codePoints, predictedWebAssignment ? 1 : chunks.length);
    if (budget.exceedsBudget) {
      return {
        success: false,
        error: `iOS nothing was typed: ${codePoints} code points would take about ${Math.ceil(budget.estimatedMs / 1000)} s, exceeding the available typing budget. Please split the text into smaller sendKeys calls, or use setText / paste where available.`,
        resolvedMode,
      };
    }
    const preparation = await this.prepareTyping(operation, signal, display, chunks.length > 1);
    if (preparation.kind === "refused") {
      return preparation.result;
    }
    this.deps.session.typingPasswordField = preparation.before?.secure === true;
    const read = {
      observer: this.deps.observer,
      timer: this.deps.timer,
      signal,
      display,
      deadlineMs: getTextRequestDeadlineMs(),
    };
    return {
      ...(await this.typePreparedText(
        { text, chunks, operation, predictedWebAssignment },
        preparation,
        read,
      )),
      resolvedMode,
    };
  }

  private async typePreparedText(
    request: {
      text: string;
      chunks: string[];
      operation: SendKeysOperation;
      predictedWebAssignment: boolean | undefined;
    },
    preparation: IosTypingPreparation,
    read: IosChunkRead,
  ): Promise<TextActionResult> {
    const { text, chunks, operation, predictedWebAssignment } = request;
    const { before, clearWarning } = preparation;
    if (chunks.length === 1 || (operation === "replace" && this.deps.assignsWebValue?.())) {
      read.signal?.throwIfAborted();
      const typed = await this.typeChunk(
        text,
        before,
        read,
        this.deps.targetLayer() !== "prototype",
      );
      return this.deps.withTextWarnings(
        operation === "replace" && typed.insertFailed
          ? this.deps.markPartialAfterMutation(typed.result)
          : typed.result,
        [clearWarning, typed.insertWarning],
      );
    }
    const refusal = predictedWebAssignment
      ? this.refuseFallbackTyping(Array.from(text).length, chunks.length, clearWarning)
      : undefined;
    return refusal ?? this.typeChunks(chunks, preparation, operation, read);
  }

  private assessTypingBudget(codePoints: number, chunkCount: number) {
    const admissionDeadlineMs = getTextRequestDeadlineMs();
    return assessIosTextToolBudget(
      codePoints,
      chunkCount,
      admissionDeadlineMs === undefined ? undefined : admissionDeadlineMs - this.deps.timer.now(),
    );
  }

  private refuseFallbackTyping(
    codePoints: number,
    chunkCount: number,
    clearWarning: string | undefined,
  ): TextActionResult | undefined {
    const budget = this.assessTypingBudget(codePoints, chunkCount);
    if (!budget.exceedsBudget) {
      return undefined;
    }
    return this.deps.withTextWarnings(
      this.deps.markPartialAfterMutation({
        success: false,
        retryable: false,
        error: `iOS field was cleared and nothing was typed: ${codePoints} code points would take about ${Math.ceil(budget.estimatedMs / 1000)} s, exceeding the remaining typing budget after falling back to XCTest. Please split the text into smaller sendKeys calls, or use setText / paste where available.`,
      }),
      [clearWarning],
    );
  }

  private async typeChunks(
    chunks: string[],
    preparation: IosTypingPreparation,
    operation: SendKeysOperation,
    read: IosChunkRead,
  ): Promise<TextActionResult> {
    let { before } = preparation;
    const targetIdentity = before?.identity;
    const warnings = new Set([preparation.clearWarning]);
    let committed = 0;
    let result: TextActionResult = { success: true };
    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) {
        read.signal?.throwIfAborted();
      }
      const interruption =
        index > 0
          ? this.chunkInterruption(read.signal, targetIdentity, before?.identity)
          : undefined;
      let typed;
      try {
        typed =
          interruption !== undefined
            ? {
                result: { success: false, error: interruption },
                after: before,
              }
            : await this.typeChunk(chunk, before, {
                ...read,
                verification: { verifyAppend: true, firstChunk: index === 0 },
              });
      } catch (error) {
        if (index === 0) {
          throw error;
        }
        logger.warn("[SendKeys] iOS chunk failed after committed text", error);
        typed = { result: { success: false, error: errorMessage(error) }, after: before };
      }
      result = typed.result;
      before = typed.after;
      warnings.add(typed.insertWarning);
      warnings.add(result.warning);
      if (!result.success) {
        result = this.chunkFailure(result, operation, { index, total: chunks.length, committed });
        break;
      }
      committed += Array.from(chunk).length;
    }
    // The existing warning helper also includes result.warning, so remove the collected copy.
    result = { ...result };
    delete result.warning;
    return this.deps.withTextWarnings(result, [...warnings]);
  }

  private chunkInterruption(
    signal: AbortSignal | undefined,
    target: string | undefined,
    current: string | undefined,
  ): string | undefined {
    if (signal?.aborted) {
      return errorMessage(signal.reason);
    }
    return target !== undefined && current !== undefined && target !== current
      ? "iOS focus moved to another field."
      : undefined;
  }

  private chunkFailure(
    result: TextActionResult,
    operation: SendKeysOperation,
    progress: { index: number; total: number; committed: number },
  ): TextActionResult {
    if (operation === "replace") {
      result = this.deps.markPartialAfterMutation(result);
    }
    const { index, total, committed } = progress;
    return {
      ...result,
      ...(committed > 0 ? { partialApplication: true, retryable: false } : {}),
      ...(isTextIndeterminateMessage(result.error) ? { retryable: false } : {}),
      error: `${result.error ?? "iOS typing failed."} iOS chunk ${index + 1} of ${total} failed; ${committed} code points committed in fully successful chunks.`,
    };
  }

  private async typeChunk(
    text: string,
    before: FocusedTextField | undefined,
    read: IosChunkRead,
    verify = true,
  ): Promise<{
    result: TextActionResult;
    after: FocusedTextField | undefined;
    insertWarning?: string;
    insertFailed?: boolean;
  }> {
    const { deadlineMs, signal } = read;
    const result = await this.deps.insert(text, {
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      timeoutMs: resolveTextCtrlProxyTimeoutMs(
        text,
        deadlineMs === undefined ? undefined : deadlineMs - this.deps.timer.now(),
      ),
      abortSignal: signal,
    });
    if (!result.success) {
      return {
        result: {
          ...result,
          error: await explainIosIndeterminateText(result.error, text, before, read),
        },
        after: before,
        insertFailed: true,
      };
    }
    if (!verify) {
      return { result, after: before };
    }
    const { after, ...verification } = await verifyIosTypedText(
      text,
      before,
      read,
      read.verification,
    );
    return { result: verification, after, insertWarning: result.warning };
  }

  private async prepareTyping(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
    includeIdentity = false,
  ): Promise<
    | { kind: "refused"; result: TextActionResult & { resolvedMode: ResolvedSendKeysTypingMode } }
    | { kind: "ready"; before: FocusedTextField | undefined; clearWarning: string | undefined }
  > {
    let clearWarning: string | undefined;
    if (operation === "replace") {
      const clearResult = await this.deps.clear(signal, display);
      if (!clearResult.success) {
        return { kind: "refused", result: { ...clearResult, resolvedMode: "xcuiTypeText" } };
      }
      clearWarning = clearResult.warning;
      signal?.throwIfAborted();
    }

    const read = {
      observer: this.deps.observer,
      timer: this.deps.timer,
      signal,
      display,
    };
    if (this.deps.targetLayer() === "prototype") {
      return {
        kind: "ready",
        before: await readIosTypedTextField(read, { includeIdentity }),
        clearWarning,
      };
    }
    const focus = await readIosTypedTextFocus(read, { includeIdentity });
    // Unavailable reads retain their existing best-effort dispatch behavior.
    if (focus.kind === "read" && !focus.hasFocusedTextInput && !focus.keyboardVisible) {
      return {
        kind: "refused",
        result: {
          success: false,
          error:
            "iOS nothing was typed: no text field has focus. Tap a text field first (e.g. tapOn), then retry.",
          resolvedMode: "xcuiTypeText",
        },
      };
    }
    return { kind: "ready", before: focus.kind === "read" ? focus.field : undefined, clearWarning };
  }
}
