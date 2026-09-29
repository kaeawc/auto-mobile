import type { ViewHierarchyResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";

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
  preTapHash: string,
): Promise<
  | { status: "unavailable" }
  | { status: "changed" }
  | { status: "unchanged"; hierarchy: ViewHierarchyResult }
> {
  await timer.sleep(POST_TAP_SETTLE_MS);
  const hierarchy = await refresh(POST_TAP_REFRESH_TIMEOUT_MS);
  if (!hierarchy) {
    return { status: "unavailable" };
  }
  const postTapHash = hash(hierarchy);
  if (postTapHash && postTapHash !== preTapHash) {
    return { status: "changed" };
  }
  return { status: "unchanged", hierarchy };
}
