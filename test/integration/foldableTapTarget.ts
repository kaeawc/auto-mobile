import type { SkeletonElement } from "../../src/models/ObserveResult";

/** Resource-id prefix of the framework ANR/crash dialog buttons (`aerr_close`, `aerr_wait`, ...). */
const SYSTEM_ERROR_DIALOG_ID_PREFIX = "android:id/aerr_";

export interface TapTarget {
  x: number;
  y: number;
  target: SkeletonElement;
}

/**
 * Picks the first labeled tappable element on the active panel and its center.
 *
 * A system ANR/crash dialog (for example a boot-time "System UI isn't responding") is drawn above
 * the launcher and is the first tappable element, so the old "first labeled element" pick tapped
 * its "Close app" button. That killed SystemUI, re-locked the device and stalled the tap past its
 * timeout in the nightly Foldable Posture lane. Fail with the dialog named instead of tapping it.
 */
export function freshTapTarget(skeleton: SkeletonElement[] | undefined): TapTarget {
  const dialogButtons = (skeleton ?? []).filter((item) =>
    item.elementId?.startsWith(SYSTEM_ERROR_DIALOG_ID_PREFIX),
  );
  if (dialogButtons.length > 0) {
    const labels = dialogButtons.map((item) => item.label ?? item.elementId).join(", ");
    throw new Error(
      `A system error dialog covers the active panel (${labels}); refusing to tap it. ` +
        "The emulator harness should dismiss boot-time ANR dialogs before tests start.",
    );
  }
  const target = skeleton?.find(
    (item) =>
      item.affordances.includes("tap") &&
      item.bounds[2] > item.bounds[0] &&
      item.bounds[3] > item.bounds[1] &&
      item.label,
  );
  if (!target) {
    throw new Error("No labeled tappable element on the active panel");
  }
  const [left, top, right, bottom] = target.bounds;
  return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2), target };
}
