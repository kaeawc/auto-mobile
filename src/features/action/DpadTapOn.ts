/**
 * tapOn on an Android device without a touchscreen, such as Android TV (#16733): move D-pad focus
 * to the match with {@link FocusNavigate}, then press enter. tvOS tapOn already selects by focus;
 * this gives Android TV the same behaviour so one flow drives both.
 */

import type {
  FocusKeyPresser,
  FocusNavigateOptions,
  FocusNavigateResult,
  FocusNavigateTarget,
} from "./FocusNavigate";

/** tapOn options only a touch tap serves: each changes which element is tapped, or when. */
const TOUCH_ONLY_OPTIONS = [
  "sibling",
  "container",
  "index",
  "searchUntil",
  "ensureChecked",
  "subtext",
  "layer",
  "display",
] as const;

/** The tapOn arguments that decide whether the D-pad can stand in for a touch tap. */
export interface DpadTapOnRequest {
  selector: {
    elementId?: string;
    text?: string;
    testTag?: string;
    textAny?: string[];
    accessibilityLink?: string;
  };
  action?: string;
  duration?: number;
  selectionStrategy?: string;
  sibling?: boolean;
  container?: object;
  index?: number;
  searchUntil?: object;
  ensureChecked?: boolean;
  subtext?: object;
  layer?: string;
  display?: string;
}

function needsTouch(request: DpadTapOnRequest): boolean {
  if ((request.action ?? "tap") !== "tap" || (request.duration ?? 0) > 0) {
    return true;
  }
  if (request.selectionStrategy !== undefined && request.selectionStrategy !== "first") {
    return true;
  }
  // ensureChecked: false asks for the unchecked state, so only the guarded touch path can skip
  // a toggle that is already there; enter would flip it.
  if (request.ensureChecked !== undefined) {
    return true;
  }
  return TOUCH_ONLY_OPTIONS.some((key) => {
    const value = request[key];
    return value !== undefined && value !== false;
  });
}

/**
 * The focus target for `request`, or undefined when it needs something only a touch tap does:
 * a selector other than text or elementId, an action other than tap, or an option such as
 * sibling, container, index or searchUntil. Options that only tune touch timing or verification
 * (preTapStability, retryIfNoChange, ensureTap) do not apply to a D-pad press and are ignored.
 */
export function dpadTapOnTarget(request: DpadTapOnRequest): FocusNavigateTarget | undefined {
  if (needsTouch(request)) {
    return undefined;
  }
  const { selector } = request;
  if (selector.testTag || selector.textAny || selector.accessibilityLink) {
    return undefined;
  }
  if (selector.text) {
    return { label: selector.text };
  }
  return selector.elementId ? { resourceId: selector.elementId } : undefined;
}

export interface DpadTapOnResult {
  success: boolean;
  action: "tap";
  /** How the tap was delivered: focus moved with the D-pad, then enter pressed. */
  inputMethod: "dpad";
  /** The focus walk that preceded enter. */
  focusNavigation: Omit<FocusNavigateResult, "success" | "message">;
  message: string;
  error?: string;
}

export interface DpadTapOnNavigator {
  execute(options: FocusNavigateOptions): Promise<FocusNavigateResult>;
}

/** Focus the target with the D-pad, then press enter on it. */
export class DpadTapOn {
  constructor(
    private readonly navigator: DpadTapOnNavigator,
    private readonly keys: FocusKeyPresser,
  ) {}

  async execute(target: FocusNavigateTarget, signal?: AbortSignal): Promise<DpadTapOnResult> {
    const navigation = await this.navigator.execute({
      until: target,
      ...(signal ? { signal } : {}),
    });
    const { success, message, ...focusNavigation } = navigation;
    const described = describeTarget(target);
    if (!success) {
      const error = `No touchscreen, and D-pad focus did not reach ${described} (${navigation.status}): ${message ?? "the target was not focused"}`;
      return {
        success: false,
        action: "tap",
        inputMethod: "dpad",
        focusNavigation,
        message: error,
        error,
      };
    }
    const pressed = await this.keys.press("enter", signal);
    if (!pressed.success) {
      const error = `No touchscreen; focused ${described} but pressing enter failed: ${pressed.error ?? "unknown error"}`;
      return {
        success: false,
        action: "tap",
        inputMethod: "dpad",
        focusNavigation,
        message: error,
        error,
      };
    }
    const presses = navigation.steps === 1 ? "1 D-pad press" : `${navigation.steps} D-pad presses`;
    return {
      success: true,
      action: "tap",
      inputMethod: "dpad",
      focusNavigation,
      message: `No touchscreen: focused ${described} with ${presses}, then pressed enter`,
    };
  }
}

function describeTarget(target: FocusNavigateTarget): string {
  if (target.label) {
    return `text=${JSON.stringify(target.label)}`;
  }
  return target.resourceId ? `id=${target.resourceId}` : "the target";
}
