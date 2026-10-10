/**
 * An Android session prototype is hidden, with its state kept, while the app it was shown over is
 * not in front. This is the one wording every surface uses for that condition; callers add the
 * advice that fits their action.
 */
export const PROTOTYPE_SUSPENDED_REASON =
  "the AutoMobile prototype is hidden because the app it was shown over is not in front";

/** Advice for tools that wait on the prototype rather than act on its elements. */
export const PROTOTYPE_SUSPENDED_WAIT_WARNING =
  `${PROTOTYPE_SUSPENDED_REASON}, so no events can arrive until that app is back in the foreground ` +
  "(the prototype returns with its state).";
