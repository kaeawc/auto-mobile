import { ActionableError, type BootedDevice, type ObserveResult } from "../../models";
import type {
  AdbCommandRunner,
  AdbExecutor,
} from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import type { Timer } from "../../utils/SystemTimer";
import { isForegroundLauncher } from "../observe/androidLauncherPackages";
import { resolveActionDisplay } from "./TargetDisplayAction";

/** A resolved pressButton display: the concrete panel key and its Android logical display id. */
export interface PressButtonDisplayTarget {
  key: string;
  displayId: number;
}

/** Resolves a `display` selector to its panel key and logical display id (#17643). */
export type PressButtonDisplayResolver = (
  display: string,
  signal: AbortSignal | undefined,
) => Promise<PressButtonDisplayTarget>;

/**
 * Resolve a pressButton `display` selector once, as tapOn does, so the key and the visual-change
 * check target the same panel. Display 0 stays explicit: an untargeted key or global action goes to
 * the focused display, which may be another panel. Other platforms refuse a `display`.
 */
export async function pressButtonDisplay(
  device: BootedDevice,
  display: string | undefined,
  {
    adb,
    resolver,
    signal,
  }: { adb: AdbCommandRunner; resolver?: PressButtonDisplayResolver; signal?: AbortSignal },
): Promise<{ key?: string; displayId?: number }> {
  if (display === undefined) {
    return {};
  }
  if (device.platform !== "android") {
    throw new ActionableError(
      `pressButton display applies to Android only; omit display on ${device.platform}.`,
    );
  }
  const target = await (resolver
    ? resolver(display, signal)
    : resolveActionDisplay(device, display, { adb, signal }));
  return target;
}

/** The `display` of a pressButton call object; positional (progress-callback) calls have none. */
export function displayOf(call: unknown): string | undefined {
  return typeof call === "object" && call !== null && "display" in call
    ? typeof call.display === "string"
      ? call.display
      : undefined
    : undefined;
}

/** `adb shell input ...` argv routed to a logical display with `-d`. */
export function inputOnDisplay(argv: string[], displayId: number | undefined): string[] {
  return displayId === undefined
    ? argv
    : [...argv.slice(0, 2), "-d", String(displayId), ...argv.slice(2)];
}

/**
 * A targeted Home press that changed nothing is accepted when the targeted display's own tree
 * already shows the launcher, as an untargeted Home is accepted on display 0 (#17647). The default
 * display's foreground check cannot answer for another display, so this reads the display-scoped
 * observation taken before the press.
 */
export async function acceptTargetedHomeAlreadyOnLauncher(
  press: {
    button: string;
    displayId: number | undefined;
    pressSucceeded: boolean;
    result: { success: boolean; error?: string };
    observation: ObserveResult | undefined;
  },
  deps: { device: BootedDevice; adb: AdbExecutor; timer: Timer; signal?: AbortSignal },
): Promise<void> {
  const { result, observation } = press;
  if (
    press.displayId === undefined ||
    press.button.toLowerCase() !== "home" ||
    !press.pressSucceeded ||
    result.error !== "No visual change observed"
  ) {
    return;
  }
  const foreground = observation?.viewHierarchy?.packageName ?? observation?.activeWindow?.appId;
  const { device, adb, timer, signal } = deps;
  const onLauncher = await isForegroundLauncher(foreground, adb, device.deviceId, {
    timer,
    signal,
    incarnationToken: deviceIncarnationToken(device.deviceId),
    formFactor: device.formFactor,
  });
  if (onLauncher) {
    result.success = true;
    delete result.error;
  }
}
