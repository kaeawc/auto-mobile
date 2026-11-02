import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import type { Timer } from "../../../utils/SystemTimer";
import {
  explainIosIndeterminateText,
  readIosTypedTextField,
  readIosTypedTextFocus,
  verifyIosTypedText,
} from "../iosTypedTextVerification";
import { getTextRequestDeadlineMs, resolveTextCtrlProxyTimeoutMs } from "../textTransportTimeout";
import type { FocusedTextField } from "../ClearText";
import type { TypingSession } from "./TypingSession";
import type {
  ResolvedSendKeysTypingMode,
  SendKeysObserver,
  SendKeysOperation,
  SendKeysTextClient,
  TextActionResult,
} from "../SendKeys";

export interface IosTyperDeps {
  session: TypingSession;
  observer: SendKeysObserver;
  timer: Timer;
  targetLayer(): HierarchyLayer | undefined;
  clear(signal?: AbortSignal, display?: string): Promise<TextActionResult>;
  insert: SendKeysTextClient["insert"];
  withTextWarnings(result: TextActionResult, warnings: Array<string | undefined>): TextActionResult;
  markPartialAfterMutation(result: TextActionResult): TextActionResult;
}

/**
 * The iOS typing path: one XCUITest typeText delivery with optional replace-clear and a
 * read-back verification. Moved out of DefaultSendKeysCommandExecutor unchanged (#11840).
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
    const preparation = await this.prepareTyping(operation, signal, display);
    if (preparation.kind === "refused") {
      return preparation.result;
    }
    const { before, clearWarning } = preparation;
    this.deps.session.typingPasswordField = before?.secure === true;
    signal?.throwIfAborted();

    // iOS has one text-delivery mechanism: XCUITest typeText. Preserve the
    // requested cross-platform mode in metadata, but report the actual mechanism.
    const deadlineMs = getTextRequestDeadlineMs();
    const result = await this.deps.insert(text, {
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      timeoutMs: resolveTextCtrlProxyTimeoutMs(
        text,
        deadlineMs === undefined ? undefined : deadlineMs - this.deps.timer.now(),
      ),
      abortSignal: signal,
    });
    if (!result.success) {
      const explained = {
        ...result,
        error: await explainIosIndeterminateText(result.error, text, before, {
          observer: this.deps.observer,
          timer: this.deps.timer,
          signal,
          display,
        }),
      };
      return {
        ...this.deps.withTextWarnings(
          operation === "replace" ? this.deps.markPartialAfterMutation(explained) : explained,
          [clearWarning],
        ),
        resolvedMode,
      };
    }
    return {
      ...this.deps.withTextWarnings(
        this.deps.targetLayer() === "prototype"
          ? result
          : await verifyIosTypedText(text, before, {
              observer: this.deps.observer,
              timer: this.deps.timer,
              signal,
              display,
            }),
        [clearWarning],
      ),
      resolvedMode,
    };
  }

  private async prepareTyping(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
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
      return { kind: "ready", before: await readIosTypedTextField(read), clearWarning };
    }
    const focus = await readIosTypedTextFocus(read);
    // Unavailable reads retain their existing best-effort dispatch behavior.
    if (focus.kind === "read" && focus.field === undefined && !focus.keyboardVisible) {
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
