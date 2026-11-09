import { ActionableError, type BootedDevice, type ObserveResult } from "../../models";
import type {
  AdbCommandRunner,
  AdbExecutor,
} from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { isForegroundLauncher } from "../observe/androidLauncherPackages";
import { resolveTargetDisplay } from "../observe/DisplaySelection";
import { displayTransitions } from "../observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import type { DisplayRef } from "../../models/DisplayPanel";
import { acceptAndroidHomeAlreadyOnLauncher } from "./pressButtonOutcomes";

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
 * The display state an unscoped observation resolves `active` from (#17649), so a pressButton
 * `active` presses on the same panel that `observe({ display: "active" })` reads. Like any explicit
 * selector, `active` overrides a session display pin.
 */
export interface PressButtonDisplayState {
  /** The panel the latest unscoped observation recorded; explicit observations leave it unchanged. */
  focusedPanel(deviceId: string): Pick<DisplayRef, "key"> | undefined;
  /** The device's live focused display, read when no unscoped observation has recorded one. */
  liveDisplay(
    device: BootedDevice,
    adb: AdbCommandRunner,
    signal: AbortSignal | undefined,
  ): Promise<Pick<DisplayRef, "key" | "posture">>;
  /** The connected logical display id for a panel key; throws the disconnected-panel guidance. */
  logicalIdForPanel(
    device: BootedDevice,
    adb: AdbCommandRunner,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<number>;
}

const defaultPressButtonDisplayState: PressButtonDisplayState = {
  focusedPanel: (deviceId) => displayTransitions.currentObservedPanel(deviceId),
  liveDisplay: async (device, adb, signal) =>
    (await new ObservedAndroidDisplayCache(defaultTimer).resolve(device, adb, signal)).display,
  logicalIdForPanel: (device, adb, key, signal) =>
    new ObservedAndroidDisplayCache(defaultTimer).logicalIdForPanel(device, adb, key, signal),
};

/**
 * Resolve a selector to its panel the way `ObserveScreen` targets a read: `active` is the focused
 * panel of the latest unscoped observation, else the live focused display (#17649). The caller's
 * last explicitly observed panel is not `active`, so the key and its verification agree.
 */
export async function resolvePressButtonDisplay(
  device: BootedDevice,
  display: string,
  {
    adb,
    signal,
    state = defaultPressButtonDisplayState,
  }: { adb: AdbCommandRunner; signal?: AbortSignal; state?: PressButtonDisplayState },
): Promise<PressButtonDisplayTarget> {
  const focused = state.focusedPanel(device.deviceId);
  const live =
    display === "active" && !focused && (device.displays?.panels.length ?? 0) > 1
      ? await state.liveDisplay(device, adb, signal)
      : undefined;
  const panel = resolveTargetDisplay(device.displays, display, {
    focusedPanelKey: focused?.key,
    activePanelKey: live?.key,
    posture: live?.posture,
  });
  return {
    key: panel.key,
    displayId: await state.logicalIdForPanel(device, adb, panel.key, signal),
  };
}

/**
 * Resolve a pressButton `display` selector once, as tapOn does, so the key and the visual-change
 * check target the same panel. `active` resolves as `observe({ display: "active" })` does (#17649).
 * A resolved display 0 stays explicit (`input -d 0`): an untargeted key or global action goes to
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
    : resolvePressButtonDisplay(device, display, { adb, signal }));
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
 * Accept a Home press that changed nothing because the launcher was already showing. Display 0 uses
 * the default-display foreground check the press itself ran (#15028). A targeted display is accepted
 * when its own observed tree already shows the launcher (#17647): the default display's foreground
 * cannot answer for another display, so this reads the display-scoped pre-press observation.
 */
export async function acceptHomeAlreadyOnLauncher(
  press: {
    button: string;
    displayId: number | undefined;
    pressSucceeded: boolean;
    launcherVerified: boolean;
    result: { success: boolean; error?: string };
    observation: ObserveResult | undefined;
  },
  deps: { device: BootedDevice; adb: AdbExecutor; timer: Timer; signal?: AbortSignal },
): Promise<void> {
  const { result, observation } = press;
  const { device } = deps;
  acceptAndroidHomeAlreadyOnLauncher(result, {
    platform: device.platform,
    button: press.button,
    pressSucceeded: press.launcherVerified,
  });
  if (
    press.displayId === undefined ||
    press.button.toLowerCase() !== "home" ||
    !press.pressSucceeded ||
    result.error !== "No visual change observed"
  ) {
    return;
  }
  const foreground = observation?.viewHierarchy?.packageName ?? observation?.activeWindow?.appId;
  const onLauncher = await isForegroundLauncher(foreground, deps.adb, device.deviceId, {
    timer: deps.timer,
    signal: deps.signal,
    incarnationToken: deviceIncarnationToken(device.deviceId),
    formFactor: device.formFactor,
  });
  if (onLauncher) {
    result.success = true;
    delete result.error;
  }
}
