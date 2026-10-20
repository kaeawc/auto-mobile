import { type CapturedTapTarget } from "./TapAnyAndroidTapper";
import { isStrictlyScoped } from "../utility/ScopedSelection";
import { returnsRawHierarchyUnfiltered } from "./tapHierarchyRead";
import { assertLongPressWithinHardMax } from "./tapSharedHelpers";
import { assertLongPressFitsRequestBudget } from "./gestureTransportTimeout";
import {
  ActionableError,
  BootedDevice,
  ObserveResult,
  TapAnyElementOptions,
  ViewHierarchyResult,
} from "../../models";
import { type Timer } from "../../utils/SystemTimer";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { attachRawViewHierarchy } from "../utility/viewHierarchySearch";
import {
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS,
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID,
} from "./tapAnyBudgets";

export function capturedTapAnyTarget(
  options: TapAnyElementOptions,
  observeResult: ObserveResult,
  picked: Pick<CapturedTapTarget, "element" | "capture" | "talkBackState">,
): CapturedTapTarget {
  return {
    ...picked,
    observationDisplay: observeResult.viewHierarchy,
    observationScreenSize: observeResult.screenSize,
    scoped: isStrictlyScoped(options),
    layer: options.layer,
  };
}

export function getTapAnyLongPressDuration(
  context: { platform: BootedDevice["platform"]; timer: Timer },
  options: TapAnyElementOptions,
  request?: { requestDeadlineMs?: number },
): number {
  if (options.action !== "longPress") {
    return 0;
  }
  assertLongPressWithinHardMax(options.duration);
  let durationMs =
    context.platform === "ios"
      ? TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS
      : TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID;
  if (options.duration && options.duration > 0) {
    // Normalize to an integer: the public schema accepts a fractional
    // duration, but CtrlProxy's `RequestTapCoordinates.duration` (iOS
    // Models.swift) is `Int?`, so a fractional value fails to decode on
    // the runner rather than performing a shorter/longer press (issue
    // #6248 review). Round rather than truncate so a value like 999.6
    // still reads as "about a second" instead of quietly losing time.
    // A sub-1ms-rounded positive duration (e.g. 0.4) must never normalize
    // to 0 -- CtrlProxy's `GesturePerformer` treats a non-positive duration
    // as a plain tap, silently downgrading a requested long press into a
    // tap that reports success (issue #6248 review, P2). Floor at 1ms so
    // any positive `duration` stays a genuine long press.
    durationMs = Math.max(1, Math.round(options.duration));
  }
  assertLongPressFitsRequestBudget(
    durationMs,
    request?.requestDeadlineMs === undefined
      ? undefined
      : request.requestDeadlineMs - context.timer.now(),
  );
  return durationMs;
}

export function throwMissingTapAnyElement(
  options: TapAnyElementOptions,
  containerFoundEver: boolean,
): never {
  if (options.container && !containerFoundEver) {
    const containerLabel = options.container.elementId
      ? `elementId '${options.container.elementId}'`
      : `text '${options.container.text}'`;
    throw new ActionableError(`Container element not found with provided ${containerLabel}`);
  }
  const containerHint = options.container
    ? ` within container ${options.container.elementId ? `elementId '${options.container.elementId}'` : `text '${options.container.text}'`}`
    : "";
  throw new ActionableError(`No clickable element found${containerHint}`);
}

export function prepareTapAnyHierarchyForResponse(
  context: { platform: BootedDevice["platform"]; viewHierarchy: ViewHierarchy },
  rawHierarchy: ViewHierarchyResult,
  screenSize?: ObserveResult["screenSize"],
): ViewHierarchyResult {
  if (returnsRawHierarchyUnfiltered(serverConfig.isRawElementSearchEnabled(), rawHierarchy)) {
    return rawHierarchy;
  }
  if (context.platform === "android") {
    const filtered = context.viewHierarchy.filterViewHierarchy(rawHierarchy);
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }
  if (context.platform === "ios") {
    return prepareTapAnyIosHierarchyForResponse(context, rawHierarchy, screenSize);
  }
  return rawHierarchy;
}

function prepareTapAnyIosHierarchyForResponse(
  context: { platform: BootedDevice["platform"]; viewHierarchy: ViewHierarchy },
  rawHierarchy: ViewHierarchyResult,
  screenSize?: ObserveResult["screenSize"],
): ViewHierarchyResult {
  if (screenSize?.width && screenSize?.height) {
    const filtered = context.viewHierarchy.filterOffscreenNodes(
      rawHierarchy,
      screenSize.width,
      screenSize.height,
    );
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }
  return rawHierarchy;
}
