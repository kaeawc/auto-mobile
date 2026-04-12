import type { TapOnElementOptions } from "../../models/TapOnElementOptions";

/**
 * For list-row / ambiguous selection paths, require this many consecutive re-finds with ε-equal
 * bounds (see {@link androidPreTapConsecutiveStableMatchesRequired}).
 */
export const ANDROID_PRE_TAP_STABLE_MATCHES_STRICT = 2;

/**
 * Plain {@link TapOnElementOptions.text} taps use one successful post-refresh re-find (same as
 * elementId-only): still never tap from pre-observe coordinates without a live hierarchy match.
 *
 * Corkill-style double stability applies when resolution is structurally churn-prone:
 * {@link TapOnElementOptions.tapClickableParent}, {@link TapOnElementOptions.siblingOfText},
 * {@link TapOnElementOptions.clickable}, or {@link TapOnElementOptions.scrollableContainer}.
 */
export function androidPreTapConsecutiveStableMatchesRequired(
  options: TapOnElementOptions
): number {
  const usesChurnProneSelection =
    options.tapClickableParent === true ||
    options.siblingOfText !== undefined ||
    options.clickable === true ||
    options.scrollableContainer === true;

  return usesChurnProneSelection ? ANDROID_PRE_TAP_STABLE_MATCHES_STRICT : 1;
}
