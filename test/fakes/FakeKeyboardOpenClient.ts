import type { KeyboardOpenClient } from "../../src/features/action/Keyboard";
import type {
  A11yActionResult,
  AccessibilityNodeSelector,
} from "../../src/features/observe/android/types";
import type { InsertTextState } from "../../src/features/observe/android/ctrlProxyProtocol";

export interface RecordedNodeAction {
  action: string;
  selector: AccessibilityNodeSelector;
}

/** Scriptable CtrlProxy slice for Keyboard.open: node click plus caret reads. */
export class FakeKeyboardOpenClient implements KeyboardOpenClient {
  readonly nodeActions: RecordedNodeAction[] = [];
  /** Signals handed to each CtrlProxy call, in call order. */
  readonly selectorSupportSignals: Array<AbortSignal | undefined> = [];
  readonly nodeActionSignals: Array<AbortSignal | undefined> = [];
  caretReadCount = 0;
  supportsSelectors = true;
  actionResult: A11yActionResult = { success: true, action: "click", totalTimeMs: 1 };
  /** Runs while a node click is in flight, e.g. to abort the caller's signal. */
  onNodeAction: (() => void) | undefined;
  /** Runs while a caret read is in flight. */
  onCaretRead: (() => void) | undefined;
  private insertStates: Array<{ success: boolean; state?: InsertTextState }> = [];

  /** Queue the caret reads returned in order; once drained reads report no state. */
  queueInsertStates(...states: Array<InsertTextState | undefined>): void {
    this.insertStates = states.map((state) => ({ success: true, state }));
  }

  async supportsNodeActionSelectors(perf?: undefined, signal?: AbortSignal): Promise<boolean> {
    void perf;
    this.selectorSupportSignals.push(signal);
    return this.supportsSelectors;
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs?: number,
    perf?: undefined,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    void timeoutMs;
    void perf;
    this.nodeActions.push({ action, selector });
    this.nodeActionSignals.push(signal);
    this.onNodeAction?.();
    return this.actionResult;
  }

  async requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }> {
    this.caretReadCount += 1;
    this.onCaretRead?.();
    return this.insertStates.shift() ?? { success: true };
  }
}
