import { ActionableError } from "../../models/ActionableError";
import type { ViewHierarchyResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";

export const ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS = 800;
// Shared with tapOn's existing no-hierarchy stability refresh cadence.
export const ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS = 500;

/** Retry missing accessibility captures without extending the original pre-tap budget. */
export async function freshTapHierarchy(
  refresh: (timeoutMs: number) => Promise<ViewHierarchyResult | null>,
  timer: Timer,
  signal?: AbortSignal,
): Promise<ViewHierarchyResult> {
  const deadline = timer.now() + ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS;
  while (timer.now() < deadline) {
    throwIfAborted(signal);
    const hierarchy = await refresh(deadline - timer.now());
    throwIfAborted(signal);
    if (hierarchy && timer.now() <= deadline) {
      return hierarchy;
    }
    const remaining = deadline - timer.now();
    if (remaining > 0) {
      await timer.sleep(Math.min(ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS, remaining));
    }
  }
  throwIfAborted(signal);
  throw new ActionableError(
    "Unable to retrieve a fresh tap hierarchy: hierarchy unavailable from the accessibility service. Observe again and check that the accessibility service is running.",
  );
}
