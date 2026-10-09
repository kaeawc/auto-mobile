/**
 * An Android session overlay is hidden, with its state kept, while the app it was shown over is
 * not in front. This is the one wording every surface uses for that condition; callers add the
 * advice that fits their action.
 */
export const OVERLAY_SUSPENDED_REASON =
  "the AutoMobile overlay is hidden because the app it was shown over is not in front";

/** Advice for tools that wait on the overlay rather than act on its elements. */
export const OVERLAY_SUSPENDED_WAIT_WARNING =
  `${OVERLAY_SUSPENDED_REASON}, so no events can arrive until that app is back in the foreground ` +
  "(the overlay returns with its state).";
