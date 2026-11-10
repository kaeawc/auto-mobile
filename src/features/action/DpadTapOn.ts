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
  FocusScreen,
} from "./FocusNavigate";
import { throwIfAborted } from "../../utils/toolUtils";
import type { DpadTargetResolver } from "./DpadTargetResolver";

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
  // The D-pad resolver matches text by substring; exact matching is a touch-path guarantee (#17782).
  "exactText",
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
  exactText?: boolean;
}

/** How long a D-pad long press holds center when tapOn gives no `duration`. */
export const DPAD_LONG_PRESS_DEFAULT_MS = 1000;

function isLongPress(request: DpadTapOnRequest): boolean {
  return request.action === "longPress";
}

function needsTouch(request: DpadTapOnRequest): boolean {
  const action = request.action ?? "tap";
  if (action !== "tap" && action !== "longPress") {
    return true;
  }
  if (action === "tap" && (request.duration ?? 0) > 0) {
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
  return selector.elementId ? { elementId: selector.elementId } : undefined;
}

/**
 * The hold, in ms, a D-pad long press keeps center down, or undefined for a plain tap. Only
 * meaningful for a request {@link dpadTapOnTarget} accepted.
 */
export function dpadTapOnHoldMs(request: DpadTapOnRequest): number | undefined {
  if (!isLongPress(request)) {
    return undefined;
  }
  return request.duration !== undefined && request.duration > 0
    ? request.duration
    : DPAD_LONG_PRESS_DEFAULT_MS;
}

export interface DpadTapOnResult {
  success: boolean;
  action: "tap" | "longPress";
  /** How the tap was delivered: focus moved with the D-pad, then enter pressed. */
  inputMethod: "dpad";
  /** The focus walk that preceded enter. */
  focusNavigation: Omit<FocusNavigateResult, "success" | "message">;
  message: string;
  error?: string;
}

/** Holds D-pad center down for a duration: the D-pad long press (`pressButton select durationMs`). */
export interface DpadSelectHolder {
  holdSelect(
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface DpadTapOnNavigator {
  execute(options: FocusNavigateOptions): Promise<FocusNavigateResult>;
}

/** Focus the target with the D-pad, then press enter on it. */
export class DpadTapOn {
  constructor(
    private readonly navigator: DpadTapOnNavigator,
    private readonly keys: FocusKeyPresser,
    private readonly resolver?: DpadTargetResolver,
    private readonly holder?: DpadSelectHolder,
  ) {}

  /** `holdMs` long-presses center for that long instead of pressing enter. */
  async execute(
    target: FocusNavigateTarget,
    signal?: AbortSignal,
    holdMs?: number,
  ): Promise<DpadTapOnResult> {
    const action = holdMs === undefined ? "tap" : "longPress";
    const navigation = await this.navigator.execute({
      until: target,
      firstMatch: true,
      ...(this.resolver
        ? { pinTarget: (screen: FocusScreen) => this.resolver?.resolve(screen, target) }
        : {}),
      ...(signal ? { signal } : {}),
    });
    const { success, message, ...focusNavigation } = navigation;
    const described = describeTarget(target);
    if (!success) {
      const error = `No touchscreen, and D-pad focus did not reach ${described} (${navigation.status}): ${message ?? "the target was not focused"}`;
      return {
        success: false,
        action,
        inputMethod: "dpad",
        focusNavigation,
        message: error,
        error,
      };
    }
    // A request cancelled during the last read must not still activate the control.
    throwIfAborted(signal);
    const pressed =
      holdMs === undefined
        ? await this.keys.press("enter", signal)
        : await this.holdCenter(holdMs, signal);
    const gesture = holdMs === undefined ? "pressing enter" : `holding center for ${holdMs} ms`;
    if (!pressed.success) {
      const error = `No touchscreen; focused ${described} but ${gesture} failed: ${pressed.error ?? "unknown error"}`;
      return {
        success: false,
        action,
        inputMethod: "dpad",
        focusNavigation,
        message: error,
        error,
      };
    }
    const presses = navigation.steps === 1 ? "1 D-pad press" : `${navigation.steps} D-pad presses`;
    return {
      success: true,
      action,
      inputMethod: "dpad",
      focusNavigation,
      message: `No touchscreen: focused ${described} with ${presses}, then ${
        holdMs === undefined ? "pressed enter" : `held center for ${holdMs} ms`
      }`,
    };
  }

  private async holdCenter(
    holdMs: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }> {
    return (
      (await this.holder?.holdSelect(holdMs, signal)) ?? {
        success: false,
        error: "this device cannot hold D-pad center",
      }
    );
  }
}

function describeTarget(target: FocusNavigateTarget): string {
  if (target.label) {
    return `text=${JSON.stringify(target.label)}`;
  }
  const id = target.elementId ?? target.resourceId;
  return id ? `id=${id}` : "the target";
}
