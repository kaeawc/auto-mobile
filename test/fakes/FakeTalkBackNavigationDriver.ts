import type { TalkBackNavigationDriver } from "../../src/features/talkback/TalkBackNavigationDriver";
import type {
  A11yActionResult,
  A11yTapCoordinatesResult,
} from "../../src/features/observe/android/types";
import { FakeFocusNavigationDriver, type FocusRequest } from "./FakeFocusNavigationDriver";

/**
 * Fake implementation of TalkBackNavigationDriver for testing.
 * Extends FakeFocusNavigationDriver with tap and action capabilities.
 */
export class FakeTalkBackNavigationDriver
  extends FakeFocusNavigationDriver
  implements TalkBackNavigationDriver
{
  tapResult: A11yTapCoordinatesResult = { success: true, totalTimeMs: 1 };
  actionResult: A11yActionResult = { success: true, action: "click", totalTimeMs: 1 };
  doubleTapCapabilitySupported = true;

  tapHistory: Array<{ x: number; y: number; durationMs: number }> = [];
  doubleTapHistory: Array<{ x: number; y: number }> = [];
  actionHistory: FocusRequest[] = [];

  tapDispatched = false;

  private tapOverrides: A11yTapCoordinatesResult[] = [];
  private actionOverrides: A11yActionResult[] = [];

  setTapResult(result: A11yTapCoordinatesResult): void {
    this.tapResult = result;
  }

  setActionResult(result: A11yActionResult): void {
    this.actionResult = result;
  }

  setNodeActionSelectorsSupported(supported: boolean): void {
    this.nodeActionSelectorsSupported = supported;
  }

  queueTapResult(result: A11yTapCoordinatesResult): void {
    this.tapOverrides.push(result);
  }

  queueActionResult(result: A11yActionResult): void {
    this.actionOverrides.push(result);
  }

  getTapCount(): number {
    return this.tapHistory.length;
  }

  getActionCount(): number {
    return this.actionHistory.length;
  }

  async requestTapCoordinates(
    x: number,
    y: number,
    durationMs: number,
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    this.tapHistory.push({ x, y, durationMs });

    const result = this.tapOverrides.shift() ?? this.tapResult;
    if (result.success || this.tapDispatched) {
      onDispatch?.();
    }
    return result;
  }

  async requestDoubleTapCoordinates(
    x: number,
    y: number,
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    if (!this.doubleTapCapabilitySupported) {
      return {
        success: false,
        totalTimeMs: 0,
        error: "tap_double_v1 is not confirmed by the connected device service",
        unsupportedCapability: "tap_double_v1",
      };
    }
    this.doubleTapHistory.push({ x, y });
    const result = this.tapOverrides.shift() ?? this.tapResult;
    if (result.success || this.tapDispatched) {
      onDispatch?.();
    }
    return result;
  }

  /** `focus` requests move the cursor (see the base fake); every other action is recorded here. */
  protected override handleAction(request: FocusRequest, signal?: AbortSignal): A11yActionResult {
    if (request.action === "focus") {
      return super.handleAction(request, signal);
    }
    this.actionHistory.push(request);

    if (this.actionOverrides.length > 0) {
      return this.actionOverrides.shift()!;
    }

    return this.actionResult;
  }
}
