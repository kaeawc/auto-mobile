import type { BootedDevice, Element, ObserveResult } from "../../../models";
import type { SystemTrayNotificationArgs } from "../systemTrayTypes";
import { findIosRevealedOpenAction } from "./hierarchy";
import { findBestNotificationMatch, resolveNotificationTapElement } from "./matching";

const SPRINGBOARD = "com.apple.springboard";
/** A stack expansion, then the revealed Open action: at most two extra taps. */
const MAX_FOLLOW_UP_TAPS = 2;

export interface IosTapFollowThroughSteps {
  tap(element: Element): Promise<void>;
  observeAfter(baseline: ObserveResult): Promise<{ observation?: ObserveResult; settled: boolean }>;
}

export interface IosTapOutcome {
  observation?: ObserveResult;
  settled: boolean;
  /** The revealed Open action was tapped to reach the notification's default action. */
  openedThroughAction: boolean;
}

const sameBounds = (a: Element["bounds"], b: Element["bounds"]): boolean =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

/**
 * On iOS 27 a tap on a cover-sheet notification does not always open its app (#19174): a stacked
 * group expands first, and a single row reveals an "Open" swipe action. While SpringBoard stays in
 * front, tap the row again where the expanded stack moved it, then the revealed Open action.
 */
export async function followIosNotificationTap(
  device: BootedDevice,
  {
    notification,
    appMatchTexts,
  }: { notification: SystemTrayNotificationArgs; appMatchTexts: string[] },
  start: { row: Element["bounds"]; observation?: ObserveResult; settled: boolean },
  steps: IosTapFollowThroughSteps,
): Promise<IosTapOutcome> {
  let { observation, settled } = start;
  let row = start.row;
  if (device.platform !== "ios" || notification.tapActionLabel) {
    return { observation, settled, openedThroughAction: false };
  }
  for (let step = 0; step < MAX_FOLLOW_UP_TAPS; step++) {
    const viewHierarchy = observation?.viewHierarchy;
    if (!observation || !viewHierarchy || viewHierarchy.packageName !== SPRINGBOARD) {
      break;
    }
    const open = findIosRevealedOpenAction(viewHierarchy, row);
    if (open) {
      await steps.tap(open);
      ({ observation, settled } = await steps.observeAfter(observation));
      return { observation, settled, openedThroughAction: true };
    }
    const rematch = findBestNotificationMatch(viewHierarchy, notification, appMatchTexts);
    const target = rematch ? resolveNotificationTapElement(rematch, notification) : null;
    if (!target || sameBounds(target.element.bounds, row)) {
      break;
    }
    row = target.element.bounds;
    await steps.tap(target.element);
    ({ observation, settled } = await steps.observeAfter(observation));
  }
  return { observation, settled, openedThroughAction: false };
}
