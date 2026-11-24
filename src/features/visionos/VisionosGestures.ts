import { ActionableError } from "../../models/ActionableError";
import type { Element } from "../../models/Element";
import type { ElementBounds } from "../../models/ElementBounds";
import type { SwipeOnOptions, SwipeOnResult, TapAtOptions, TapAtResult } from "../../models";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { normalizeVisionosHierarchy } from "./VisionosHierarchy";
import { requireVisionosRunner, withVisionosHostRecovery } from "./VisionosRunnerLifecycle";

/** Stroke durations the runner accepts (VisionCommandPolicy.swipeDurationRangeMs). */
export const VISIONOS_SWIPE_DURATION_RANGE_MS = { min: 50, max: 10_000 } as const;

/**
 * Fractions of the target's extent a swipe starts and ends at along its axis. They stay clear of
 * the window bar and resize corners at the window's edges.
 */
const SWIPE_START = 0.75;
const SWIPE_END = 0.25;

/** Options left unset or `false` (a negated option is the default) are not refused. */
function refusedOptions(options: object, allowed: readonly string[]): string[] {
  return Object.entries(options)
    .filter(([key, value]) => value !== undefined && value !== false && !allowed.includes(key))
    .map(([key]) => key);
}

function isWindowCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateTapAt(
  options: TapAtOptions,
): asserts options is TapAtOptions & { x: number; y: number } {
  if (options.action !== undefined && options.action !== "tap") {
    throw new ActionableError(
      `visionOS tapAt supports only action tap, not ${options.action}; long press and double tap are not available.`,
    );
  }
  const refused = refusedOptions(options, ["action", "x", "y", "coordinateSpace"]);
  if (refused.length > 0 || (options.coordinateSpace ?? "absolute") !== "absolute") {
    const names = [
      ...refused,
      ...(options.coordinateSpace && options.coordinateSpace !== "absolute"
        ? [`coordinateSpace ${options.coordinateSpace}`]
        : []),
    ];
    throw new ActionableError(
      `visionOS tapAt does not support ${names.join(", ")}; pass absolute x/y in window points, as observe reports element bounds.`,
    );
  }
  if (!isWindowCoordinate(options.x) || !isWindowCoordinate(options.y)) {
    throw new ActionableError(
      "visionOS tapAt requires finite non-negative x/y in window points, as observe reports element bounds.",
    );
  }
}

/** A tap at a window point through the runner's XCUICoordinate, in the observed app's window. */
export async function visionosTapAt(
  deviceId: string,
  options: TapAtOptions,
  signal?: AbortSignal,
): Promise<TapAtResult> {
  validateTapAt(options);
  const { x, y } = options;
  // A tap refused because the host app is gone was never applied, so one retry is safe.
  await withVisionosHostRecovery(deviceId, signal, async () => {
    const client = await requireVisionosRunner(deviceId, signal);
    signal?.throwIfAborted();
    await client.request({ type: "request_tap_coordinates", x, y }, signal);
  });
  return { success: true, x, y, action: "tap", dispatchRoute: "xcuiCoordinate" };
}

function swipeDuration(options: SwipeOnOptions): number {
  const duration =
    options.durationMs ?? new DefaultElementGeometry().getSwipeDurationFromSpeed(options.speed);
  const { min, max } = VISIONOS_SWIPE_DURATION_RANGE_MS;
  if (!Number.isFinite(duration) || duration < min || duration > max) {
    throw new ActionableError(`visionOS swipe durationMs must be from ${min} to ${max}.`);
  }
  return Math.round(duration);
}

function validateSwipe(options: SwipeOnOptions): void {
  const refused = [
    ...refusedOptions(options, [
      "direction",
      "gestureType",
      "autoTarget",
      "container",
      "speed",
      "durationMs",
    ]),
    ...(options.container
      ? refusedOptions(options.container, ["elementId", "text", "index"]).map(
          (key) => `container.${key}`,
        )
      : []),
  ];
  if (refused.length > 0) {
    throw new ActionableError(
      `visionOS swipeOn does not support ${refused.join(", ")}; swipe the app window or a container by elementId or text.`,
    );
  }
  const container = options.container;
  if (container && container.elementId === undefined && container.text === undefined) {
    throw new ActionableError("visionOS swipeOn container needs an elementId or text.");
  }
  if (
    container?.index !== undefined &&
    (!Number.isInteger(container.index) || container.index < 0)
  ) {
    throw new ActionableError("visionOS swipeOn container index must be a non-negative integer.");
  }
}

function resolveContainer(
  elements: readonly Element[],
  container: NonNullable<SwipeOnOptions["container"]>,
): Element {
  const matches = elements.filter(
    (element) =>
      (container.elementId === undefined ||
        element["resource-id"] === container.elementId ||
        element["view-id"] === container.elementId) &&
      (container.text === undefined || element.text === container.text),
  );
  const element = matches[container.index ?? 0];
  if (!element) {
    throw new ActionableError(
      "No visionOS element matched the swipe container; observe and use its identifier or exact text.",
    );
  }
  if (element.space === "ornament") {
    // Ornament frames are scene-local, so their points do not land on the ornament.
    throw new ActionableError(
      "The visionOS swipe container is in an ornament, whose bounds cannot be swiped by coordinate; tap its controls with tapOn instead.",
    );
  }
  return element;
}

type Stroke = Pick<SwipeOnResult, "x1" | "y1" | "x2" | "y2">;

/** A stroke through the centre of `bounds` in the finger's direction. */
export function visionosSwipeStroke(
  bounds: ElementBounds,
  direction: SwipeOnOptions["direction"],
): Stroke {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const x = bounds.left + width / 2;
  const y = bounds.top + height / 2;
  const along = (start: number, extent: number, fraction: number) => start + extent * fraction;
  switch (direction) {
    case "up":
      return {
        x1: x,
        y1: along(bounds.top, height, SWIPE_START),
        x2: x,
        y2: along(bounds.top, height, SWIPE_END),
      };
    case "down":
      return {
        x1: x,
        y1: along(bounds.top, height, SWIPE_END),
        x2: x,
        y2: along(bounds.top, height, SWIPE_START),
      };
    case "left":
      return {
        x1: along(bounds.left, width, SWIPE_START),
        y1: y,
        x2: along(bounds.left, width, SWIPE_END),
        y2: y,
      };
    case "right":
      return {
        x1: along(bounds.left, width, SWIPE_END),
        y1: y,
        x2: along(bounds.left, width, SWIPE_START),
        y2: y,
      };
    default:
      throw new ActionableError("Invalid visionOS swipe direction.");
  }
}

const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" } as const;

/**
 * A straight XCUICoordinate drag across the app window, or across a container element, in window
 * points. There is no scrolling search: observe after the swipe to see where the content moved.
 */
export async function visionosSwipeOn(
  deviceId: string,
  options: SwipeOnOptions,
  signal?: AbortSignal,
): Promise<SwipeOnResult> {
  validateSwipe(options);
  const duration = swipeDuration(options);
  const direction =
    options.gestureType === "scrollTowardsDirection"
      ? OPPOSITE[options.direction]
      : options.direction;
  return withVisionosHostRecovery(deviceId, signal, async () => {
    const client = await requireVisionosRunner(deviceId, signal);
    const raw = await client.hierarchy(signal);
    const element = options.container
      ? resolveContainer(
          new DefaultElementParser()
            .flattenViewHierarchy(normalizeVisionosHierarchy(raw))
            .map(({ element: flattened }) => flattened),
          options.container,
        )
      : undefined;
    // The client validated the hierarchy, so the app window's bounds are present and finite.
    const stroke = visionosSwipeStroke(element?.bounds ?? raw.hierarchy.bounds!, direction);
    signal?.throwIfAborted();
    await client.request({ type: "request_swipe", ...stroke, duration }, signal);
    return {
      success: true,
      targetType: element ? "element" : "screen",
      ...(element ? { element } : {}),
      ...stroke,
      duration,
    };
  });
}

/** The Digital Crown press (XCUIDevice home); visionOS has no other scriptable button. */
export async function visionosPress(deviceId: string, button: string, signal?: AbortSignal) {
  if (button.toLowerCase() !== "home") {
    throw new ActionableError(
      `visionOS pressButton supports only home (the Digital Crown press), not ${button}.`,
    );
  }
  await withVisionosHostRecovery(deviceId, signal, async () => {
    const client = await requireVisionosRunner(deviceId, signal);
    signal?.throwIfAborted();
    await client.request({ type: "request_press_home" }, signal);
  });
  return { success: true, button, keyCode: 0 };
}
