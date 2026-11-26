import { ActionableError, type BootedDevice, type ObserveResult } from "../../../models";
import { logger } from "../../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import type { SystemTrayOutcome } from "../SystemTray";
import type { SystemTrayArgs } from "../systemTrayTypes";
import { getSystemTrayDependencies } from "./dependencies";
import { sleep } from "./runtime";
import { returnToWatchFace, watchAwaySurface } from "./watchFace";
import { readWatchNow } from "./watchRead";
import {
  isWearHierarchy,
  WEAR_SYSTEM_UI,
  watchHasExpandedCard,
  watchNotifications,
  watchStreamRoot,
} from "./watchHierarchy";

const BACK = "shell input keyevent 4";
const POLL_MS = 250;
const CLOSE_POLLS = 8;
const MAX_CLOSE_PRESSES = 3;
/** How long one Back is watched for the stream to slide out. */
const BACK_WAIT_MS = CLOSE_POLLS * POLL_MS;
/** Reads an app the action opened is given to replace the stream in the captured tree. */
const HAND_OFF_POLLS = 8;
const SYSTEM_UI_PACKAGES = new Set([WEAR_SYSTEM_UI, "com.android.systemui"]);
/**
 * Closing stops this long before the restore deadline, so a read still in flight finishes and
 * "did not close" is reported before the deadline aborts cleanup with a bare timeout.
 */
export const CLOSE_RESERVE_MS = 2_000;

/** What the action did that cleanup must undo. */
export interface WatchRestoreState {
  /** The stream was showing before the action, so it is left open. */
  initiallyOpen: boolean;
  /** An app list present before the action must not trigger watch-face recovery. */
  initiallyOnAppList: boolean;
  /** The action expanded a card, which Back collapses first. */
  expandedByUs: boolean;
  /**
   * Set when the action may open an app: the package resumed just before the tapped target, so an
   * app resumed by the tap is told apart from one that was already in front.
   */
  handOffFrom?: { resumed: string | undefined };
  /** Absolute time (injected timer) at which the caller aborts cleanup. */
  deadline: number;
}

// Cleanup deliberately ignores request cancellation, as on the phone clear path: it runs on its
// own signal, aborted only by its own deadline.
function read(device: BootedDevice, signal: AbortSignal): Promise<ObserveResult> {
  return readWatchNow(device, signal);
}

function back(device: BootedDevice, signal: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  return awaitWhileRequestIsLive(
    getSystemTrayDependencies().adbFactory(device).executeCommand(BACK, { signal }),
    signal,
  );
}

/**
 * The package of the resumed activity. The back stack is read from dumpsys on every observation,
 * while the CtrlProxy tree can be one cached before the last input, so an app the tap started
 * shows here before it replaces the stream in the tree (#16829).
 */
export function resumedPackage(observation: ObserveResult): string | undefined {
  const backStack = observation.backStack;
  const taskId = backStack?.currentActivity?.taskId ?? backStack?.currentTaskId;
  return backStack?.tasks.find((task) => task.id === taskId)?.packageName;
}

/** The app the action handed off to: one SystemUI does not own and that was not resumed before. */
function handedOffApp(observation: ObserveResult, state: WatchRestoreState): string | undefined {
  const resumed = resumedPackage(observation);
  return state.handOffFrom &&
    resumed &&
    !SYSTEM_UI_PACKAGES.has(resumed) &&
    resumed !== state.handOffFrom.resumed
    ? resumed
    : undefined;
}

/**
 * The action opened an app. A tree read straight after the tap can still be the cached one showing
 * the expanded card, and Back would send the app it opened to the background (#16829), so wait,
 * bounded, for the tree to show the app instead. Whatever the last read shows, nothing is pressed
 * while the app stays resumed.
 */
async function settleHandOff(
  device: BootedDevice,
  first: ObserveResult,
  state: WatchRestoreState,
  signal: AbortSignal,
): Promise<ObserveResult> {
  const timer = getSystemTrayDependencies().timer;
  let current = first;
  for (
    let poll = 0;
    poll < HAND_OFF_POLLS &&
    isWearHierarchy(current.viewHierarchy) &&
    handedOffApp(current, state) &&
    timer.now() < state.deadline - CLOSE_RESERVE_MS;
    poll++
  ) {
    await sleep(POLL_MS, signal);
    current = await read(device, signal);
  }
  return current;
}

/** Returns the watch to the screen the action started from, and the final observation. */
export async function restoreWatchStream(
  device: BootedDevice,
  state: WatchRestoreState,
  signal: AbortSignal,
): Promise<ObserveResult> {
  let current = await read(device, signal);
  if (handedOffApp(current, state)) {
    current = await settleHandOff(device, current, state, signal);
    // An app that already went away again (a trampoline that finished) leaves the stream behind.
    if (handedOffApp(current, state)) {
      return current;
    }
  }
  if (state.expandedByUs && watchHasExpandedCard(current.viewHierarchy)) {
    current = await collapseCard(device, current, signal);
  } else if (
    state.expandedByUs &&
    !watchStreamRoot(current.viewHierarchy) &&
    isWearHierarchy(current.viewHierarchy)
  ) {
    await back(device, signal);
    current = await read(device, signal);
  }
  if (!state.initiallyOpen && watchStreamRoot(current.viewHierarchy)) {
    current = await closeStream(device, state.deadline - CLOSE_RESERVE_MS, signal);
  }
  if (!state.initiallyOnAppList && watchAwaySurface(current) === "app list") {
    return recoverWatchFace(device, current, signal);
  }
  return current;
}

/**
 * Best effort: returns the confirmation read, or the last observation if recovery or that read
 * fails. The caller judges the result with `unrestoredDismissal`, so an app, the app list or the
 * stream in the confirmation read is reported rather than taken as the watch face.
 */
async function recoverWatchFace(
  device: BootedDevice,
  current: ObserveResult,
  signal: AbortSignal,
): Promise<ObserveResult> {
  try {
    await returnToWatchFace(device, current, signal);
    const confirmed = await read(device, signal);
    if (watchAwaySurface(confirmed) || watchStreamRoot(confirmed.viewHierarchy)) {
      logger.warn("[systemTray] Watch face could not be confirmed after stream restoration");
    }
    return confirmed;
  } catch (error) {
    logger.warn("[systemTray] Could not recover the watch face after stream restoration", error);
    return current;
  }
}

/** Back collapses a card expanded in place; wait for it, without closing the stream twice. */
async function collapseCard(
  device: BootedDevice,
  first: ObserveResult,
  signal: AbortSignal,
): Promise<ObserveResult> {
  await back(device, signal);
  let current = first;
  for (let poll = 0; poll < CLOSE_POLLS; poll++) {
    current = await read(device, signal);
    if (!watchStreamRoot(current.viewHierarchy) || !watchHasExpandedCard(current.viewHierarchy)) {
      return current;
    }
    await sleep(POLL_MS, signal);
  }
  return current;
}

/**
 * Press Back and wait for the stream to be gone. It slides out over a second or so, so a read
 * straight after Back still sees it (#17317). A second Back is pressed only while a card is
 * still expanded: on the watch face Back opens the app launcher, so an impatient repeat would
 * leave the watch somewhere the next request cannot open the stream from. For the same reason
 * every Back is preceded by a fresh read: a stream that closed on its own since the last read
 * (its last card removed, a slow host) leaves the watch face in front, where Back would open the
 * app list (#17546). An emptied stream is given time to close itself before sending Back. Every
 * wait is bounded by `closeBy`, so a slow watch gets the "did not close" error, not the deadline.
 */
async function closeStream(
  device: BootedDevice,
  closeBy: number,
  signal: AbortSignal,
): Promise<ObserveResult> {
  const timer = getSystemTrayDependencies().timer;
  const left = () => closeBy - timer.now();
  for (let press = 0; press < MAX_CLOSE_PRESSES && left() > 0; press++) {
    let current = await read(device, signal);
    if (!watchStreamRoot(current.viewHierarchy)) {
      return current;
    }
    // The self-close wait only spends time a following Back could still be watched in.
    for (
      let poll = 0;
      poll < CLOSE_POLLS &&
      watchNotifications(current.viewHierarchy).length === 0 &&
      left() > BACK_WAIT_MS;
      poll++
    ) {
      await sleep(POLL_MS, signal);
      current = await read(device, signal);
      if (!watchStreamRoot(current.viewHierarchy)) {
        return current;
      }
    }
    await back(device, signal);
    for (let poll = 0; poll < CLOSE_POLLS && left() > 0; poll++) {
      current = await read(device, signal);
      if (!watchStreamRoot(current.viewHierarchy)) {
        return current;
      }
      await sleep(POLL_MS, signal);
    }
    if (!watchHasExpandedCard(current.viewHierarchy)) {
      break;
    }
  }
  throw new ActionableError(
    "Watch notification stream did not close after returning to the previous screen.",
  );
}

/**
 * Where cleanup left the watch, if that is not the screen the dismissal started from: an app, the
 * app list, or the stream re-opened when it started closed. Only the watch face (or the surface
 * the action started on) counts as restored.
 */
function unrestoredSurface(
  initial: ObserveResult,
  restored: ObserveResult,
): "app list" | "app" | "stream" | undefined {
  if (watchStreamRoot(restored.viewHierarchy)) {
    return watchStreamRoot(initial.viewHierarchy) ? undefined : "stream";
  }
  const surface = watchAwaySurface(restored);
  if (!surface || surface !== watchAwaySurface(initial)) {
    return surface;
  }
  // The same kind of surface it started on counts only when it is the same app.
  return surface === "app" && restored.activeWindow?.appId !== initial.activeWindow?.appId
    ? surface
    : undefined;
}

const UNRESTORED_MESSAGES = {
  "app list":
    "Dismissed the watch notification, but closing the stream left the watch on the app list instead of the watch face. Press Back to return to the watch face.",
  app: "Dismissed the watch notification, but closing the stream left an app in front instead of the watch face. Press Home to return to the watch face.",
  stream:
    "Dismissed the watch notification, but the notification stream is open again instead of the watch face. Press Back to return to the watch face.",
} as const;

/**
 * A dismissal is not reported as a success unless cleanup confirmed the watch back on the screen
 * it started from (#17546): the caller would be left somewhere it never asked for. The card's
 * removal itself was confirmed, so `dismissedCount` is kept.
 */
export function unrestoredDismissal(
  args: SystemTrayArgs,
  result: SystemTrayOutcome,
  initial: ObserveResult,
  restored: ObserveResult | undefined,
): SystemTrayOutcome {
  if (!["dismiss", "clearAll"].includes(args.action) || result.isError || !restored) {
    return result;
  }
  const surface = unrestoredSurface(initial, restored);
  if (!surface) {
    return result;
  }
  return {
    payload: {
      ...result.payload,
      code: "dismissal_unconfirmed",
      message: UNRESTORED_MESSAGES[surface],
      success: false,
    },
    isError: true,
  };
}
