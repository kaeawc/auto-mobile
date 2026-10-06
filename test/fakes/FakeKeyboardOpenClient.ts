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
  supportsSelectors = true;
  actionResult: A11yActionResult = { success: true, action: "click", totalTimeMs: 1 };
  private insertStates: Array<{ success: boolean; state?: InsertTextState }> = [];

  /** Queue the caret reads returned in order; once drained reads report no state. */
  queueInsertStates(...states: Array<InsertTextState | undefined>): void {
    this.insertStates = states.map((state) => ({ success: true, state }));
  }

  async supportsNodeActionSelectors(): Promise<boolean> {
    return this.supportsSelectors;
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
  ): Promise<A11yActionResult> {
    this.nodeActions.push({ action, selector });
    return this.actionResult;
  }

  async requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }> {
    return this.insertStates.shift() ?? { success: true };
  }
}
