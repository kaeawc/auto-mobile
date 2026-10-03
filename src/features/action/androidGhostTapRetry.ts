import type { ViewHierarchyResult } from "../../models";
import { StaleDisplayError } from "../../models/StaleDisplayError";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { DisplaySelectionError } from "../observe/DisplaySelection";

// Activity transitions can take 1–2s; settle and refresh before judging a tap.
export const POST_TAP_SETTLE_MS = 300;
export const POST_TAP_REFRESH_TIMEOUT_MS = 1500;
// Let the gesture queue drain before the one permitted retry.
export const PRE_RETRY_DELAY_MS = 100;

/** The single post-gesture probe shared by tapOn and tapAny. The caller owns retry targeting. */
export async function checkAndroidTapHierarchyChange(
  timer: Timer,
  refresh: (timeoutMs: number) => Promise<ViewHierarchyResult | null>,
  hash: (hierarchy: ViewHierarchyResult) => string | null,
  preTapHash: string | null,
  signal?: AbortSignal,
): Promise<
  | { status: "unavailable" }
  | { status: "changed" }
  | { status: "unchanged"; hierarchy: ViewHierarchyResult }
> {
  signal = combineWithAmbientAbort(signal);
  throwIfAborted(signal);
  await timer.sleep(POST_TAP_SETTLE_MS);
  throwIfAborted(signal);
  let hierarchy: ViewHierarchyResult | null;
  try {
    hierarchy = await refresh(POST_TAP_REFRESH_TIMEOUT_MS);
  } catch (error) {
    // Cancellation and display refusals must retain the caller's typed failure.
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError") ||
      error instanceof StaleDisplayError ||
      error instanceof DisplaySelectionError
    ) {
      throw error;
    }
    logger.warn(
      `[androidGhostTapRetry] Post-tap hierarchy unreadable: ${errorMessage(error)}`,
      error,
    );
    return { status: "unavailable" };
  }
  throwIfAborted(signal);
  if (!hierarchy || !preTapHash) {
    return { status: "unavailable" };
  }
  const postTapHash = hash(hierarchy);
  if (!postTapHash) {
    return { status: "unavailable" };
  }
  if (postTapHash !== preTapHash) {
    return { status: "changed" };
  }
  return { status: "unchanged", hierarchy };
}
