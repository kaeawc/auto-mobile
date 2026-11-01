import { ActionableError } from "../../models/ActionableError";
import type {
  Element,
  Platform,
  SwipeOnOptions,
  SwipeOnResult,
  TapAtOptions,
  TapAtResult,
  TapOnElementOptions,
  TapOnElementResult,
} from "../../models";
import { DefaultElementParser } from "../utility/ElementParser";
import { normalizeWatchHierarchy } from "./WatchHierarchy";
import { type WatchRunnerClient } from "./WatchRunnerClient";
import { watchRunners } from "./WatchRunnerRegistry";

export function unsupportedWatchAction(action: string): never {
  throw new ActionableError(
    `${action} is not supported by the watchOS runner; use tap, directional swipe or home.`,
  );
}

/** Shared early refusal for feature entry points that the watch runner cannot execute. */
export function rejectWatchAction(platform: Platform, action: string): void {
  if (platform === "watchos") {
    unsupportedWatchAction(action);
  }
}

function rejectOptions(options: object, allowed: readonly string[]): void {
  const refused = Object.entries(options).filter(
    // false requests a verified unchecked state; the watch runner cannot check either state.
    ([key, value]) =>
      value !== undefined && (value !== false || key === "ensureChecked") && !allowed.includes(key),
  );
  if (refused.length) {
    unsupportedWatchAction(`watchOS options ${refused.map(([key]) => key).join(", ")}`);
  }
}

async function elements(
  client: WatchRunnerClient,
  signal?: AbortSignal,
): Promise<{ all: Element[]; available: Element[] }> {
  const hierarchy = normalizeWatchHierarchy(await client.hierarchy(signal));
  const all = new DefaultElementParser()
    .flattenViewHierarchy(hierarchy)
    .map((entry) => entry.element);
  const available = all.filter((element) => {
    const { left, top, right, bottom } = element.bounds;
    return (
      right > left &&
      bottom > top &&
      left >= 0 &&
      top >= 0 &&
      right <= hierarchy.screenWidth! &&
      bottom <= hierarchy.screenHeight!
    );
  });
  return { all, available };
}

function matches(element: Element, selector: { elementId?: string; text?: string }): boolean {
  return (
    (selector.elementId !== undefined || selector.text !== undefined) &&
    (selector.elementId === undefined ||
      element["resource-id"] === selector.elementId ||
      element["view-id"] === selector.elementId) &&
    (selector.text === undefined || element.text === selector.text)
  );
}

export async function watchTapOn(
  deviceId: string,
  options: TapOnElementOptions,
  signal?: AbortSignal,
): Promise<TapOnElementResult> {
  // Must precede hierarchy reads, not just the tap itself: long press is never advertised.
  if (options.action !== "tap") {
    unsupportedWatchAction(options.action);
  }
  rejectOptions(options, ["action", "elementId", "text", "index"]);
  if (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0)) {
    throw new ActionableError("watchOS tap index must be a non-negative integer.");
  }
  signal?.throwIfAborted();
  const client = watchRunners.require(deviceId);
  const { all, available } = await elements(client, signal);
  const candidates = available.filter((element) => matches(element, options));
  const element = candidates[options.index ?? 0];
  if (!element) {
    throw new ActionableError(
      "No watch element matched; observe and check the identifier or exact text.",
    );
  }
  const { left, top, right, bottom } = element.bounds;
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  await client.request(
    element["resource-id"] &&
      all.filter((candidate) => candidate["resource-id"] === element["resource-id"]).length === 1
      ? { type: "tap", identifier: element["resource-id"] }
      : { type: "tap", x, y },
    signal,
  );
  return { success: true, action: "tap", element };
}

export async function watchTapAt(
  deviceId: string,
  options: TapAtOptions,
  signal?: AbortSignal,
): Promise<TapAtResult> {
  if (options.action !== undefined && options.action !== "tap") {
    unsupportedWatchAction(options.action);
  }
  rejectOptions(options, ["action", "x", "y", "coordinateSpace"]);
  if (options.coordinateSpace !== undefined && options.coordinateSpace !== "absolute") {
    unsupportedWatchAction("non-absolute coordinates");
  }
  if (
    typeof options.x !== "number" ||
    typeof options.y !== "number" ||
    !Number.isFinite(options.x) ||
    !Number.isFinite(options.y) ||
    options.x < 0 ||
    options.y < 0
  ) {
    throw new ActionableError("watchOS tap requires finite non-negative x/y in XCTest points.");
  }
  signal?.throwIfAborted();
  await watchRunners.require(deviceId).request({ type: "tap", x: options.x, y: options.y }, signal);
  return { success: true, x: options.x, y: options.y, action: "tap" };
}

function validateWatchSwipe(options: SwipeOnOptions): number {
  rejectOptions(options, ["direction", "gestureType", "lookFor", "autoTarget"]);
  if (options.lookFor) {
    rejectOptions(options.lookFor, ["text", "elementId", "maxSwipes"]);
  }
  const maxSwipes = options.lookFor ? (options.lookFor.maxSwipes ?? 10) : 1;
  if (!Number.isInteger(maxSwipes) || maxSwipes < 0 || maxSwipes > 100) {
    throw new ActionableError("watchOS maxSwipes must be an integer from 0 to 100.");
  }
  return maxSwipes;
}

export async function watchSwipeOn(
  deviceId: string,
  options: SwipeOnOptions,
  signal?: AbortSignal,
): Promise<SwipeOnResult> {
  const maxSwipes = validateWatchSwipe(options);
  const opposite = { up: "down", down: "up", left: "right", right: "left" } as const;
  const direction =
    options.gestureType === "scrollTowardsDirection"
      ? opposite[options.direction]
      : options.direction;
  if (!Object.hasOwn(opposite, direction)) {
    throw new ActionableError("Invalid watch swipe direction.");
  }
  signal?.throwIfAborted();
  const client = watchRunners.require(deviceId);
  let count = 0;
  let found: Element | undefined;
  for (;;) {
    if (options.lookFor) {
      found = (await elements(client, signal)).available.find((element) =>
        matches(element, options.lookFor!),
      );
    }
    if (found || count >= maxSwipes) {
      break;
    }
    await client.request({ type: "swipe", direction }, signal);
    count++;
  }
  return {
    success: options.lookFor === undefined || !!found,
    ...(options.lookFor && !found
      ? { error: "No watch element matched within the swipe limit; observe before trying again." }
      : {}),
    targetType: "screen",
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    duration: 0,
    durationIgnored: true,
    warning:
      "watchOS performs a directional swipe; stroke coordinates and duration are unavailable.",
    ...(options.lookFor ? { found: !!found, element: found, scrollIterations: count } : {}),
  };
}

export async function watchPress(deviceId: string, button: string, signal?: AbortSignal) {
  if (button.toLowerCase() !== "home") {
    unsupportedWatchAction(`press ${button}`);
  }
  signal?.throwIfAborted();
  await watchRunners.require(deviceId).request({ type: "home" }, signal);
  return { success: true, button, keyCode: 0 };
}
