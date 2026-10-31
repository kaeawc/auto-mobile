import type { BootedDevice } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import {
  pointerNeedsInstrumentation,
  stylusButtonMask,
  type PointerOption,
} from "../../../models/PointerOption";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { StylusOutcomeIndeterminateError } from "../stylusPointer";
import { errorMessage } from "../../../utils/describeUnknownError";
import { PointerNotSentError, createInstrumentationDispatch } from "./instrumentationDispatch";
import { createUinputDispatch } from "./uinputDispatch";
import type {
  PointerEnvironment,
  PointerInjector,
  PointerPoint,
  PointerRequest,
} from "./PointerInjector";
import { defaultPointerRoutes } from "./pointerRoutes";
import { readPointerEnvironment } from "./readPointerEnvironment";
import { requirePointerRoute } from "./selectPointerRoute";

/** A press and release long enough for an app to see a tap with a pressure curve. */
export const RICH_TAP_DURATION_MS = 40;

export { pointerNeedsInstrumentation };

export interface RichStylusOptions {
  signal?: AbortSignal;
  /** Throws when the display changed since the target was resolved; runs just before dispatch. */
  assertCurrent?: () => void;
  /** Reports that the injection is about to be sent. */
  onDispatch?: () => void;
  readEnvironment?: (signal?: AbortSignal) => Promise<PointerEnvironment>;
  injectors?: readonly PointerInjector[];
}

export interface RichStylusPoint {
  x: number;
  y: number;
  durationMs?: number;
  pressure?: number;
  tilt?: number;
  orientation?: number;
}

/** A stylus stroke carrying the pointer's constant axes on every point that gives no value of its own. */
export function strokeRequest(
  pointer: PointerOption,
  points: readonly RichStylusPoint[],
  shape: { path?: boolean } = {},
): PointerRequest {
  const filled: PointerPoint[] = points.map((point) => {
    const pressure = point.pressure ?? pointer.pressure;
    const tilt = point.tilt ?? pointer.tilt;
    const orientation = point.orientation ?? pointer.orientation;
    return {
      x: point.x,
      y: point.y,
      ...(point.durationMs === undefined ? {} : { durationMs: point.durationMs }),
      ...(pressure === undefined ? {} : { pressure }),
      ...(tilt === undefined ? {} : { tilt }),
      ...(orientation === undefined ? {} : { orientation }),
    };
  });
  const buttons = stylusButtonMask(pointer.buttons);
  // What the request actually needs, so a refusal names the real reason.
  return {
    features: {
      toolType: pointer.toolType,
      ...(filled.some((point) => point.pressure !== undefined && point.pressure !== 1)
        ? { variablePressure: true }
        : {}),
      ...(buttons !== 0 ||
      filled.some((point) => point.tilt !== undefined || point.orientation !== undefined)
        ? { extendedAxes: true }
        : {}),
      ...(shape.path ? { path: true } : {}),
    },
    points: filled,
    buttons,
  };
}

/** A tap or long press as a down and up at one point. */
export function tapStrokePoints(
  point: { x: number; y: number },
  durationMs: number | undefined,
): RichStylusPoint[] {
  return [point, { ...point, durationMs: durationMs ?? RICH_TAP_DURATION_MS }];
}

/**
 * Sends a stylus stroke that `adb input stylus` cannot express through the instrumentation route,
 * or the root-only uinput route where the runner cannot.
 * The route is chosen from the device first: a device or runner that cannot honour it is refused
 * before anything is sent, and the stroke is never turned into a finger touch.
 */
export async function dispatchRichStylus(
  device: BootedDevice,
  adb: AdbExecutor,
  request: PointerRequest,
  options: RichStylusOptions = {},
): Promise<void> {
  const environment = await (
    options.readEnvironment ?? ((signal) => readPointerEnvironment(device, adb, signal))
  )(options.signal);
  const injectors =
    options.injectors ??
    defaultPointerRoutes({
      a11y: refuseNonStylus,
      adbInputSource: refuseNonStylus,
      instrumentation: createInstrumentationDispatch(adb, device.deviceId),
      uinput: createUinputDispatch(adb, device.deviceId),
    });
  const route = requirePointerRoute(request.features, environment, injectors);
  options.assertCurrent?.();
  options.onDispatch?.();
  try {
    await route.inject(request, options.signal);
  } catch (error) {
    // A failure the route says happened before anything was sent is retry-safe; any other failure
    // after dispatch may have applied part of the stroke.
    if (error instanceof PointerNotSentError || options.signal?.aborted) {
      throw error;
    }
    throw new StylusOutcomeIndeterminateError(errorMessage(error), { cause: error });
  }
}

async function refuseNonStylus(): Promise<void> {
  throw new ActionableError("This route cannot inject a stylus with pressure, tilt or buttons.");
}
