import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import type { PointerOption } from "../../models/PointerOption";
import { LONG_PRESS_DEFAULT_MS } from "./tapAtGesture";
import { resolveGestureCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import { executeShellInput, inputDurationArgument } from "./touchscreenInput";

/**
 * First Android release whose `input` command sets the injected event's tool type from its source.
 * Read from the AOSP tags: `android-12.0.0_r1` `InputShellCommand.injectMotionEvent` assigns
 * `toolType = getToolType(inputSource)` (`TOOL_TYPE_STYLUS` for the stylus source), while
 * `android-9.0.0_r61` to `android-11.0.0_r48` `Input.java` build the event with the legacy
 * `MotionEvent.obtain` overload that carries no tool type. Releases before API 28 were not read
 * and are refused with the rest. A device-side probe of the received tool type is still pending (#13082).
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
 * Capability error for a stylus request, or undefined when it can be injected (or no pointer was
 * requested). Everything that is not supported fails here, before any input, so nothing ever
 * degrades to a finger touch. The device is read only after the static checks pass.
 */
export async function checkStylusPointer(
  adb: Pick<AdbExecutor, "executeCommand">,
  request: StylusRequest,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { pointer, platform, gesture, display } = request;
  if (pointer === undefined) {
    return undefined;
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

/** Capability error for a `tapAt` request, or undefined to proceed (see {@link checkStylusPointer}). */
export function stylusTapRefusal(
  adb: Pick<AdbExecutor, "executeCommand">,
  platform: string,
  options: StylusTapRequest,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return checkStylusPointer(
    adb,
    {
      pointer: options.pointer,
      platform,
      gesture: options.action ?? "tap",
      display: options.display,
    },
    signal,
  );
}

/** A stylus tap, or a long press expressed as a zero-distance swipe with a duration. */
export async function dispatchStylusTap(
  adb: AdbExecutor,
  point: { x: number; y: number },
  gesture: { action?: StylusGesture; durationMs?: number },
  options: StylusDispatchOptions = {},
): Promise<void> {
  const { x, y } = point;
  if (gesture.action !== "longPress") {
    await executeShellInput(adb, stylusInputCommand(`tap ${x} ${y}`), options);
    return;
  }
  const durationMs = gesture.durationMs ?? LONG_PRESS_DEFAULT_MS;
  await executeShellInput(
    adb,
    stylusInputCommand(`swipe ${x} ${y} ${x} ${y} ${inputDurationArgument(durationMs)}`),
    { ...options, timeoutMs: resolveGestureCtrlProxyTimeoutMs(durationMs) },
  );
}

/** A straight two-point stylus swipe. */
export async function dispatchStylusSwipe(
  adb: AdbExecutor,
  gesture: { from: { x: number; y: number }; to: { x: number; y: number }; duration: number },
  options: StylusDispatchOptions = {},
): Promise<void> {
  const { from, to, duration } = gesture;
  await executeShellInput(
    adb,
    stylusInputCommand(
      `swipe ${from.x} ${from.y} ${to.x} ${to.y} ${inputDurationArgument(duration)}`,
    ),
    { ...options, timeoutMs: resolveGestureCtrlProxyTimeoutMs(duration) },
  );
}
