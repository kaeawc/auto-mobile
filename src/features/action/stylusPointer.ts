import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import type { TapAtResult } from "../../models";
import type { PointerOption } from "../../models/PointerOption";
import { LONG_PRESS_DEFAULT_MS } from "./tapAtGesture";
import { resolveGestureCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import { indeterminateTapError } from "./coordinateTapDispatch";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  InputCommandRejectedError,
  executeShellInput,
  inputDurationArgument,
} from "./touchscreenInput";

/**
 * First Android release whose `input` command sets the injected event's tool type from its source.
 * Read from the AOSP tags: `android-12.0.0_r1` `InputShellCommand.injectMotionEvent` assigns
 * `toolType = getToolType(inputSource)` (`TOOL_TYPE_STYLUS` for the stylus source), while `Input.java`
 * from `android-7.0.0_r36` through `android-11.0.0_r48` builds the event with the legacy
 * `MotionEvent.obtain` overload that carries no tool type, so API 24 to 30 are refused. Releases
 * before API 24 were not read. A device-side probe of the received tool type is still pending (#13082).
 */
export const STYLUS_INPUT_MIN_SDK = 31;

const SDK_READ_TIMEOUT_MS = 5000;

export type StylusGesture = "tap" | "longPress" | "doubleTap" | "swipe";

export interface StylusRequest {
  pointer: PointerOption | undefined;
  platform: string;
  gesture: StylusGesture;
  display?: string;
}

export function stylusInputCommand(action: string): string {
  return `shell input stylus ${action}`;
}

/**
 * Capability error that needs no device read, or undefined. Everything unsupported fails here,
 * before any input, so nothing ever degrades to a finger touch.
 */
export function stylusRefusal(request: StylusRequest): string | undefined {
  const { pointer, platform, gesture, display } = request;
  if (pointer === undefined) {
    return undefined;
  }
  if (pointer.toolType !== "stylus") {
    return `pointer.toolType "${pointer.toolType}" is not supported; only "stylus" can be injected`;
  }
  if (platform !== "android") {
    return 'pointer.toolType "stylus" is Android-only; omit pointer on iOS';
  }
  if (pointer.pressure !== undefined && pointer.pressure !== 1) {
    return `stylus input injects pressure 1.0 only; pressure ${pointer.pressure} is not supported (omit pressure or pass 1)`;
  }
  if (gesture === "doubleTap") {
    return "stylus pointer does not support doubleTap yet; use tap or longPress";
  }
  if (display !== undefined) {
    return "stylus pointer does not support display selection yet; omit display";
  }
  return undefined;
}

/**
 * Capability error from the device's Android API level, or undefined. This awaits a device read, so
 * the dispatch helpers run it after the display fence is captured and before the fence is re-checked.
 */
export async function stylusSdkRefusal(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const apiLevel = await readAndroidDeviceApiLevel(
    adb as AdbExecutor,
    SDK_READ_TIMEOUT_MS,
    undefined,
    signal,
  );
  if (apiLevel === null) {
    return `could not read the device's Android API level, so stylus input is refused (it needs API ${STYLUS_INPUT_MIN_SDK} or newer)`;
  }
  if (apiLevel < STYLUS_INPUT_MIN_SDK) {
    return `stylus input needs Android API ${STYLUS_INPUT_MIN_SDK} or newer (this device reports API ${apiLevel}): older releases build the injected event without a stylus tool type`;
  }
  return undefined;
}

/** Both checks in order; the device is read only after the static ones pass. */
export async function checkStylusPointer(
  adb: Pick<AdbExecutor, "executeCommand">,
  request: StylusRequest,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return stylusRefusal(request) ?? (request.pointer ? stylusSdkRefusal(adb, signal) : undefined);
}

async function assertStylusSdkSupported(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<void> {
  const refusal = await stylusSdkRefusal(adb, signal);
  if (refusal) {
    throw new ActionableError(refusal);
  }
}

export interface StylusDispatchOptions {
  signal?: AbortSignal;
  /** Throws when the display changed since the target was resolved. */
  assertCurrent?: () => void;
  /** Reports that the command is about to be sent. */
  onDispatch?: () => void;
}

/** The pointer-related fields of a `tapAt` request. */
interface StylusTapRequest {
  pointer?: PointerOption;
  action?: StylusGesture;
  display?: string;
}

/** Static capability error for a `tapAt` request, or undefined to proceed (see {@link stylusRefusal}). */
export function stylusTapRefusal(platform: string, options: StylusTapRequest): string | undefined {
  return stylusRefusal({
    pointer: options.pointer,
    platform,
    gesture: options.action ?? "tap",
    display: options.display,
  });
}

/** The failed `tapAt` result for a refused stylus request; nothing was sent to the device. */
export function refusedTap(
  error: string,
  point: { x: number; y: number },
  action: TapAtResult["action"] = "tap",
): TapAtResult {
  return { success: false, x: point.x, y: point.y, action, error };
}

/**
 * True when a failure came after the command was sent and the device did not refuse it: a timeout,
 * a lost connection or a cancelled hold may have left the gesture applied, so a retry could repeat it.
 */
export function failedAfterDispatch(error: unknown, dispatched: boolean): boolean {
  return dispatched && !(error instanceof InputCommandRejectedError);
}

/** A stylus tap, or a long press expressed as a zero-distance swipe with a duration. */
export async function dispatchStylusTap(
  adb: AdbExecutor,
  point: { x: number; y: number },
  gesture: { action?: StylusGesture; durationMs?: number },
  options: StylusDispatchOptions = {},
): Promise<void> {
  const { x, y } = point;
  const durationMs = gesture.durationMs ?? LONG_PRESS_DEFAULT_MS;
  const longPress = gesture.action === "longPress";
  const command = longPress
    ? stylusInputCommand(`swipe ${x} ${y} ${x} ${y} ${inputDurationArgument(durationMs)}`)
    : stylusInputCommand(`tap ${x} ${y}`);
  let dispatched = false;
  try {
    await assertStylusSdkSupported(adb, options.signal);
    await executeShellInput(adb, command, {
      ...options,
      timeoutMs: longPress ? resolveGestureCtrlProxyTimeoutMs(durationMs) : undefined,
      onDispatch: () => {
        dispatched = true;
        options.onDispatch?.();
      },
    });
  } catch (error) {
    if (failedAfterDispatch(error, dispatched)) {
      throw indeterminateTapError(errorMessage(error));
    }
    throw error;
  }
}

/** A straight two-point stylus swipe. */
export async function dispatchStylusSwipe(
  adb: AdbExecutor,
  gesture: { from: { x: number; y: number }; to: { x: number; y: number }; duration: number },
  options: StylusDispatchOptions = {},
): Promise<void> {
  const { from, to, duration } = gesture;
  await assertStylusSdkSupported(adb, options.signal);
  await executeShellInput(
    adb,
    stylusInputCommand(
      `swipe ${from.x} ${from.y} ${to.x} ${to.y} ${inputDurationArgument(duration)}`,
    ),
    { ...options, timeoutMs: resolveGestureCtrlProxyTimeoutMs(duration) },
  );
}
