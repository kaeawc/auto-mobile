import { ActionableError } from "../../models/ActionableError";
import type {
  Element,
  BootedDevice,
  Platform,
  SwipeOnOptions,
  SwipeOnResult,
  TapAtOptions,
  TapAtResult,
  TapOnElementOptions,
  TapOnElementResult,
} from "../../models";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  matches,
  matchWatchTapCandidates,
  watchHierarchyElements,
  readOpenSmartStack,
  tapSmartStackAt,
  tapSmartStackOn,
} from "./WatchSmartStackTap";
import { normalizeWatchHierarchy } from "./WatchHierarchy";
import { type WatchCommand, type WatchRunnerClient } from "./WatchRunnerClient";
import { WatchRunnerError } from "./WatchRunnerError";
import { watchRunners } from "./WatchRunnerRegistry";

export function unsupportedWatchAction(action: string): never {
  throw new ActionableError(
    `${action} is not supported by the watchOS runner; use tap, directional swipe, rotateCrown or home.`,
  );
}

/**
 * Fraction of the screen extent one lookFor swipe moves the content. The runner's default swipe
 * scrolls about two screens on a watch, so a target one screen away is skipped between reads.
 */
export const WATCH_LOOK_FOR_SWIPE_DISTANCE = 0.4;

export interface WatchCrownOptions {
  /** Signed crown turn in full revolutions (XCUI `rotateDigitalCrown(delta:)`): 1 is one turn. */
  delta: number;
  velocity?: number;
}

// Simulator crown rotation has not replied within the 5 s default.
// This bounds when the call is reported as a timeout, not its expected duration.
export const CROWN_REQUEST_TIMEOUT_MS = 30_000;

const CROWN_UNCHANGED_PREFIX = "rotateCrown changed nothing";
// The runner names the stuck value and the turn size itself when the focused control is readable.
const CROWN_STUCK_VALUE_MARKER = "The focused control's value stayed";

/**
 * When the focused control exposes a value, the runner reports that value and both causes (too
 * small a turn, or the limit). Otherwise it cannot tell a turn too small to cross one step from a
 * scroll limit or no crown focus, so for a sub-revolution delta name the size as a possible cause.
 */
export function crownUnchangedHint(error: unknown, delta: number): unknown {
  if (
    !(error instanceof WatchRunnerError) ||
    !error.message.startsWith(CROWN_UNCHANGED_PREFIX) ||
    error.message.includes(CROWN_STUCK_VALUE_MARKER) ||
    Math.abs(delta) >= 1
  ) {
    return error;
  }
  return new WatchRunnerError(
    `${error.message} A delta of ${delta} is ${Math.abs(delta)} of one crown revolution and may be ` +
      "smaller than one step of the focused control; if it is not at its limit, try a larger delta.",
    error.errorCode,
  );
}

export async function watchRotateCrown(
  device: Pick<BootedDevice, "deviceId" | "platform">,
  options: WatchCrownOptions,
  signal?: AbortSignal,
) {
  if (device.platform !== "watchos") {
    throw new ActionableError(
      "rotateCrown requires a watchOS device; target an Apple Watch session.",
    );
  }
  const { delta, velocity = 1 } = options;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) {
    throw new ActionableError("rotateCrown delta must be a finite non-zero number.");
  }
  if (typeof velocity !== "number" || !Number.isFinite(velocity) || velocity <= 0) {
    throw new ActionableError("rotateCrown velocity must be a finite number greater than zero.");
  }
  signal?.throwIfAborted();
  try {
    await watchRunners
      .require(device.deviceId)
      .request({ type: "crown", delta, velocity }, signal, { timeoutMs: CROWN_REQUEST_TIMEOUT_MS });
  } catch (error) {
    // Runner failures are already structured; only an unchanged sub-revolution turn gains a hint.
    throw crownUnchangedHint(error, delta);
  }
  return { success: true, delta, velocity };
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
  return watchHierarchyElements(hierarchy);
}

/** Stable input-first ordering for sendKeys; ordinary taps retain hierarchy order. */
export function orderWatchTapCandidates(
  candidates: readonly Element[],
  preferTextInput: boolean,
): Element[] {
  const isTextInput = (element: Element) =>
    ["XCUIElementType(45)", "XCUIElementType(49)", "XCUIElementType(50)"].includes(
      element.class ?? "",
    );
  return preferTextInput
    ? candidates.toSorted((a, b) => Number(isTextInput(b)) - Number(isTextInput(a)))
    : [...candidates];
}

function validateWatchTapOn(options: TapOnElementOptions): void {
  // Must precede hierarchy reads, not just the tap itself: long press is never advertised.
  if (options.action !== "tap") {
    unsupportedWatchAction(options.action);
  }
  rejectOptions(options, ["action", "elementId", "text", "index"]);
  if (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0)) {
    throw new ActionableError("watchOS tap index must be a non-negative integer.");
  }
}

export async function watchTapOn(
  deviceId: string,
  options: TapOnElementOptions,
  signal?: AbortSignal,
  preferTextInput = false,
): Promise<TapOnElementResult> {
  validateWatchTapOn(options);
  signal?.throwIfAborted();
  const client = watchRunners.require(deviceId);
  const stack = await readOpenSmartStack(client, () => defaultTimer.now(), signal);
  if (stack) {
    return tapSmartStackOn(client, stack, options, signal);
  }
  const { all, available } = await elements(client, signal);
  const candidates = orderWatchTapCandidates(
    matchWatchTapCandidates(available, options),
    options.text !== undefined && preferTextInput,
  );
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

function validateWatchTapAt(
  options: TapAtOptions,
): asserts options is TapAtOptions & { x: number; y: number } {
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
}

export async function watchTapAt(
  deviceId: string,
  options: TapAtOptions,
  signal?: AbortSignal,
): Promise<TapAtResult> {
  validateWatchTapAt(options);
  signal?.throwIfAborted();
  const client = watchRunners.require(deviceId);
  const stack = await readOpenSmartStack(client, () => defaultTimer.now(), signal);
  if (stack) {
    await tapSmartStackAt(client, stack.hierarchy, options, signal);
  } else {
    await client.request({ type: "tap", x: options.x, y: options.y }, signal);
  }
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

function swipeCommand(direction: "up" | "down" | "left" | "right", lookFor: boolean): WatchCommand {
  return lookFor
    ? { type: "swipe", direction, distance: WATCH_LOOK_FOR_SWIPE_DISTANCE }
    : { type: "swipe", direction };
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
    await client.request(swipeCommand(direction, !!options.lookFor), signal);
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
