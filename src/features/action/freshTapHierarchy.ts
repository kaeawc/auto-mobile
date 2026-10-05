import { ActionableError } from "../../models/ActionableError";
import type { ViewHierarchyResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";

export const ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS = 800;
// Shared with tapOn's existing no-hierarchy stability refresh cadence.
export const ANDROID_PRE_TAP_NO_HIERARCHY_DELAY_MS = 500;

/** Retry missing accessibility captures within the caller's pre-tap budget. */
export async function freshTapHierarchy(
  refresh: (timeoutMs: number) => Promise<ViewHierarchyResult | null>,
  timer: Timer,
  signal?: AbortSignal,
  {
    timeoutMs = ANDROID_PRE_TAP_REFRESH_TIMEOUT_MS,
    context = "while TalkBack is on",
  }: {
    timeoutMs?: number;
    context?: string;
  } = {},
): Promise<ViewHierarchyResult> {
  const deadline = timer.now() + Math.max(0, timeoutMs);
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
    `Unable to retrieve a fresh tap hierarchy: hierarchy unavailable from the accessibility service ${context}. Observe again and check that the accessibility service is running.`,
  );
}
