import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import type { Timer } from "../../../utils/SystemTimer";
import { readIosTypedTextField, verifyIosTypedText } from "../iosTypedTextVerification";
import { getTextRequestDeadlineMs, resolveTextCtrlProxyTimeoutMs } from "../textTransportTimeout";
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
    let clearWarning: string | undefined;
    if (operation === "replace") {
      const clearResult = await this.deps.clear(signal, display);
      if (!clearResult.success) {
        return { ...clearResult, resolvedMode };
      }
      clearWarning = clearResult.warning;
      signal?.throwIfAborted();
    }

    const before = await readIosTypedTextField(
      this.deps.observer,
      this.deps.timer,
      signal,
      display,
    );
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
      return {
        ...this.deps.withTextWarnings(
          operation === "replace" ? this.deps.markPartialAfterMutation(result) : result,
          [clearWarning],
        ),
        resolvedMode,
      };
    }
    return {
      ...this.deps.withTextWarnings(
        this.deps.targetLayer() === "prototype"
          ? result
          : await verifyIosTypedText(
              text,
              before,
              this.deps.observer,
              this.deps.timer,
              signal,
              display,
            ),
        [clearWarning],
      ),
      resolvedMode,
    };
  }
}
