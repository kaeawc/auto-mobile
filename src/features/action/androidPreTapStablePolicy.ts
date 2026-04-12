import type { TapOnElementOptions } from "../../models/TapOnElementOptions";

/**
 * For text / list-row style selection, require this many consecutive re-finds with ε-equal bounds
 * (see {@link androidPreTapConsecutiveStableMatchesRequired}).
 */
export const ANDROID_PRE_TAP_STABLE_MATCHES_STRICT = 2;

/**
 * Text and ambiguous list taps can shift geometry between hierarchy dumps; resource-id chrome is
 * usually unique. Corkill-style protection stays on text / clickable / sibling paths; elementId-only
 * taps accept one successful post-refresh re-find (still never using pre-observe coordinates alone).
 */
export function androidPreTapConsecutiveStableMatchesRequired(
  options: TapOnElementOptions
): number {
  const usesChurnProneSelection =
    options.text !== undefined ||
    options.tapClickableParent === true ||
    options.siblingOfText !== undefined ||
    options.clickable === true ||
    options.scrollableContainer === true;

  return usesChurnProneSelection ? ANDROID_PRE_TAP_STABLE_MATCHES_STRICT : 1;
}
