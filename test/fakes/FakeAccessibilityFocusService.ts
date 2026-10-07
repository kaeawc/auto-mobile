import type { CurrentFocusResult, Element } from "../../src/models";
import type { AccessibilityFocusService } from "../../src/features/accessibility/SetAccessibilityFocus";

type FocusCall = { method: "set" | "clear"; resourceId: string };

/**
 * Fake AccessibilityFocusService for unit tests. Records set/clear calls, can be
 * configured to throw, and returns a configurable current-focus result.
 */
export class FakeAccessibilityFocusService implements AccessibilityFocusService {
  calls: FocusCall[] = [];
  currentFocusElement: Element | null = null;
  private setThrows: Error | null = null;
  private clearThrows: Error | null = null;
  private currentFocusThrows: Error | null = null;
  private currentFocusError: string | null = null;

  setSetThrows(err: Error): void {
    this.setThrows = err;
  }

  setClearThrows(err: Error): void {
    this.clearThrows = err;
  }

  setCurrentFocusThrows(err: Error): void {
    this.currentFocusThrows = err;
  }

  /**
   * Mirror the production client: a failed, timed-out or disconnected read-back
   * resolves an error-carrying result (never throws) — see CtrlProxyFocus.requestCurrentFocus.
   */
  setCurrentFocusError(error: string): void {
    this.currentFocusError = error;
  }

  async setAccessibilityFocus(resourceId: string): Promise<void> {
    this.calls.push({ method: "set", resourceId });
    if (this.setThrows) {
      throw this.setThrows;
    }
  }

  async clearAccessibilityFocus(resourceId: string): Promise<void> {
    this.calls.push({ method: "clear", resourceId });
    if (this.clearThrows) {
      throw this.clearThrows;
    }
  }

  async requestCurrentFocus(): Promise<CurrentFocusResult> {
    if (this.currentFocusThrows) {
      throw this.currentFocusThrows;
    }
    if (this.currentFocusError) {
      return { focusedElement: null, totalTimeMs: 5000, error: this.currentFocusError };
    }
    return { focusedElement: this.currentFocusElement, totalTimeMs: 1 };
  }
}
