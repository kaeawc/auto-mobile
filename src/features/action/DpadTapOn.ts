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

const UNFOCUSABLE_SELECTORS = ["testTag", "textAny", "accessibilityLink"] as const;

function isSet(request: DpadTapOnRequest, key: (typeof TOUCH_ONLY_OPTIONS)[number]): boolean {
  const value = request[key];
  // ensureChecked: false asks for the unchecked state, so only the guarded touch path can skip
  // a toggle that is already there; enter would flip it.
  return key === "ensureChecked" ? value !== undefined : value !== undefined && value !== false;
}

function actionBlockers(request: DpadTapOnRequest): string[] {
  const action = request.action ?? "tap";
  if (action !== "tap" && action !== "longPress") {
    return [`action: "${action}"`];
  }
  return action === "tap" && (request.duration ?? 0) > 0 ? ['duration with action: "tap"'] : [];
}

function selectorBlockers(request: DpadTapOnRequest): string[] {
  const { selector } = request;
  const unfocusable = UNFOCUSABLE_SELECTORS.filter((key) => selector[key] !== undefined).map(
    (key) => `selector.${key}`,
  );
  if (unfocusable.length > 0) {
    return unfocusable;
  }
  return selector.text || selector.elementId ? [] : ["a selector without text or elementId"];
}

/**
 * The parts of `request` only a touch tap serves, named as the caller wrote them; empty when the
 * D-pad can stand in for the tap. Options that only tune touch timing or verification
 * (preTapStability, retryIfNoChange, ensureTap) do not apply to a D-pad press and are not listed.
 */
export function dpadTapOnTouchOnlyParts(request: DpadTapOnRequest): string[] {
  const strategy =
    request.selectionStrategy !== undefined && request.selectionStrategy !== "first"
      ? [`selectionStrategy: "${request.selectionStrategy}"`]
      : [];
  return [
    ...actionBlockers(request),
    ...strategy,
    ...TOUCH_ONLY_OPTIONS.filter((key) => isSet(request, key)),
    ...selectorBlockers(request),
  ];
}

/**
 * The focus target for `request`, or undefined when it needs something only a touch tap does
 * (see {@link dpadTapOnTouchOnlyParts}).
 */
export function dpadTapOnTarget(request: DpadTapOnRequest): FocusNavigateTarget | undefined {
  if (dpadTapOnTouchOnlyParts(request).length > 0) {
    return undefined;
  }
  const { selector } = request;
  if (selector.text) {
    return { label: selector.text };
  }
  return selector.elementId ? { elementId: selector.elementId } : undefined;
}

/**
 * Whether `request` activates a semantic link (`selector.accessibilityLink` or owner-scoped
 * `subtext`). The accessibility service invokes the span's click handler itself, so no touch is
 * injected and the request works the same on a device without a touchscreen. tapOn's own
 * validation keeps these requests to a plain tap with no touch-only option.
 */
export function usesNativeLinkActivation(request: DpadTapOnRequest): boolean {
  return request.selector.accessibilityLink !== undefined || request.subtext !== undefined;
}

/**
 * Why a tapOn cannot run on a device without a touchscreen, and the D-pad form that can. A touch
 * tap there is a silent no-op (#17913), so the caller must refuse rather than inject one.
 */
export function dpadTapOnRefusal(parts: readonly string[]): string {
  const named = parts.length > 0 ? parts.join(", ") : "this request";
  return (
    `tapOn cannot use ${named} on this device: it has no touchscreen (Android TV), so a touch ` +
    `tap would not reach the app. Name the element to activate with only selector.text or ` +
    `selector.elementId (action "tap" or "longPress") so tapOn moves D-pad focus to it and ` +
    `presses enter, or move focus with focusNavigate and press pressButton "select".`
  );
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
