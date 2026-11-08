import { ActionableError, type BootedDevice, type ObserveResult } from "../../../models";
import { logger } from "../../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import { getSystemTrayDependencies } from "./dependencies";
import { ensureSystemTrayOpen, observeSystemTray, sleep } from "./runtime";
import { isWatchAppList, isWearHierarchy, WEAR_SYSTEM_UI, watchStreamRoot } from "./watchHierarchy";

const BACK = "shell input keyevent 4";
const HOME = "shell input keyevent KEYCODE_HOME";
/** App, then app list, then the watch face: never more presses than surfaces to leave. */
const MAX_PRESSES = 3;
const POLL_MS = 250;
const POLLS_PER_PRESS = 8;
/** The launcher's exit animation still swallows a swipe after its nodes are gone. */
const SETTLE_MS = 500;

/** A screen the watch open swipe does nothing on (#17443). */
export type WatchAwaySurface = "app list" | "app";

/**
 * Only positive evidence counts: Home on the watch face opens the app list, so a screen that
 * merely is not recognised must be left alone. The app list is the Wear launcher's `appsList` (or
 * its `AllAppsLauncherActivity` in focus); an app is a non-Wear hierarchy whose package is also
 * the focused window's.
 */
export function watchAwaySurface(observation: ObserveResult): WatchAwaySurface | undefined {
  if (watchStreamRoot(observation.viewHierarchy)) {
    return undefined;
  }
  if (isAppList(observation)) {
    return "app list";
  }
  return isAppInFront(observation) ? "app" : undefined;
}

function isAppList({ viewHierarchy, activeWindow }: ObserveResult): boolean {
  return (
    isWatchAppList(viewHierarchy) ||
    !!activeWindow?.activityName?.includes("AllAppsLauncherActivity")
  );
}

function isAppInFront({ viewHierarchy, activeWindow }: ObserveResult): boolean {
  const appId = activeWindow?.appId;
  return (
    !!appId &&
    appId !== WEAR_SYSTEM_UI &&
    !activeWindow.systemOverlay &&
    viewHierarchy?.packageName === appId &&
    !isWearHierarchy(viewHierarchy)
  );
}

function readWatch(device: BootedDevice, signal?: AbortSignal): Promise<ObserveResult> {
  return observeSystemTray(
    getSystemTrayDependencies().observeScreenFactory(device),
    0,
    signal,
    true,
  );
}

/** Press one key, then wait for the screen to leave `from`. */
async function pressAway(
  device: BootedDevice,
  from: WatchAwaySurface,
  key: string,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(
    getSystemTrayDependencies().adbFactory(device).executeCommand(key, { signal }),
    signal,
  );
  let current = await readWatch(device, signal);
  for (let poll = 1; poll < POLLS_PER_PRESS && watchAwaySurface(current) === from; poll++) {
    await sleep(POLL_MS, signal);
    current = await readWatch(device, signal);
  }
  return current;
}

/**
 * Bring the watch face to the front before the open swipe, which only works there (#17443).
 * Back closes the app list (Home toggles it from the face); Home leaves an app. A screen that is
 * already the watch face, or not recognised, is returned untouched.
 */
export async function returnToWatchFace(
  device: BootedDevice,
  initial: ObserveResult,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  let current = initial;
  let away = watchAwaySurface(current);
  if (!away) {
    return current;
  }
  for (let press = 0; away && press < MAX_PRESSES; press++) {
    const key = away === "app list" && press === 0 ? BACK : HOME;
    logger.info(`[systemTray] Leaving the watch ${away} for the watch face before opening`);
    current = await pressAway(device, away, key, signal);
    away = watchAwaySurface(current);
  }
  if (away) {
    throw new ActionableError(
      `Could not return to the watch face from the ${away}; the notification stream opens only from the watch face. Press the watch's side button to show the watch face, then retry.`,
    );
  }
  await sleep(SETTLE_MS, signal);
  return readWatch(device, signal);
}

/** A fresh read of the watch, brought back to the watch face when it was elsewhere. */
export async function readWatchFace(
  device: BootedDevice,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  return returnToWatchFace(device, await readWatch(device, signal), signal);
}

/** The `open` action: return to the watch face, then open the stream from there. */
export async function openWatchStream(device: BootedDevice, timeout: number, signal?: AbortSignal) {
  const initialObservation = await readWatchFace(device, signal);
  return ensureSystemTrayOpen(device, timeout, { signal, initialObservation });
}
