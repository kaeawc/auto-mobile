import { ActionableError, type BootedDevice, type ObserveResult } from "../../../models";
import { logger } from "../../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import type { SystemTrayOutcome } from "../SystemTray";
import type { SystemTrayArgs } from "../systemTrayTypes";
import { getSystemTrayDependencies } from "./dependencies";
import { observeSystemTray, sleep } from "./runtime";
import { returnToWatchFace, watchAwaySurface } from "./watchFace";
import {
  isWearHierarchy,
  watchHasExpandedCard,
  watchNotifications,
  watchStreamRoot,
} from "./watchHierarchy";

const BACK = "shell input keyevent 4";
const POLL_MS = 250;
const CLOSE_POLLS = 8;
const MAX_CLOSE_PRESSES = 3;

/** What the action did that cleanup must undo. */
export interface WatchRestoreState {
  /** The stream was showing before the action, so it is left open. */
  initiallyOpen: boolean;
  /** An app list present before the action must not trigger watch-face recovery. */
  initiallyOnAppList: boolean;
  /** The action expanded a card, which Back collapses first. */
  expandedByUs: boolean;
}

// Cleanup deliberately ignores request cancellation, as on the phone clear path: it runs on its
// own signal, aborted only by its own deadline.
function read(device: BootedDevice, signal: AbortSignal): Promise<ObserveResult> {
  return observeSystemTray(
    getSystemTrayDependencies().observeScreenFactory(device),
    0,
    signal,
    true,
  );
}

function back(device: BootedDevice, signal: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  return awaitWhileRequestIsLive(
    getSystemTrayDependencies().adbFactory(device).executeCommand(BACK, { signal }),
    signal,
  );
}

/** Returns the watch to the screen the action started from, and the final observation. */
export async function restoreWatchStream(
  device: BootedDevice,
  state: WatchRestoreState,
  signal: AbortSignal,
): Promise<ObserveResult> {
  let current = await read(device, signal);
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
    current = await closeStream(device, signal);
  }
  if (!state.initiallyOnAppList && watchAwaySurface(current) === "app list") {
    return recoverWatchFace(device, current, signal);
  }
  return current;
}

/** Best effort: retain the last observation if recovery or its confirmation read fails. */
async function recoverWatchFace(
  device: BootedDevice,
  current: ObserveResult,
  signal: AbortSignal,
): Promise<ObserveResult> {
  try {
    await returnToWatchFace(device, current, signal);
    current = await read(device, signal);
    if (watchAwaySurface(current) || watchStreamRoot(current.viewHierarchy)) {
      throw new ActionableError("Watch face could not be confirmed after stream restoration.");
    }
  } catch (error) {
    logger.warn("[systemTray] Could not recover the watch face after stream restoration", error);
  }
  return current;
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
 * app list (#17546). An emptied stream is given time to close itself before sending Back.
 */
async function closeStream(device: BootedDevice, signal: AbortSignal): Promise<ObserveResult> {
  for (let press = 0; press < MAX_CLOSE_PRESSES; press++) {
    let current = await read(device, signal);
    if (!watchStreamRoot(current.viewHierarchy)) {
      return current;
    }
    for (
      let poll = 0;
      poll < CLOSE_POLLS && watchNotifications(current.viewHierarchy).length === 0;
      poll++
    ) {
      await sleep(POLL_MS, signal);
      current = await read(device, signal);
      if (!watchStreamRoot(current.viewHierarchy)) {
        return current;
      }
    }
    await back(device, signal);
    for (let poll = 0; poll < CLOSE_POLLS; poll++) {
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
 * A dismissal is not reported as a success when closing the stream left the watch on the app list
 * rather than the screen it started from: the caller would be left somewhere it never asked for
 * (#17546). The card's removal itself was confirmed, so `dismissedCount` is kept.
 */
export function unrestoredDismissal(
  args: SystemTrayArgs,
  result: SystemTrayOutcome,
  initial: ObserveResult,
  restored: ObserveResult | undefined,
): SystemTrayOutcome {
  if (
    !["dismiss", "clearAll"].includes(args.action) ||
    result.isError ||
    !restored ||
    watchAwaySurface(restored) !== "app list" ||
    watchAwaySurface(initial) === "app list"
  ) {
    return result;
  }
  return {
    payload: {
      ...result.payload,
      code: "dismissal_unconfirmed",
      message:
        "Dismissed the watch notification, but closing the stream left the watch on the app list instead of the watch face. Press Back to return to the watch face.",
      success: false,
    },
    isError: true,
  };
}
