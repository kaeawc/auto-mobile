import type { TapOnElementOptions } from "../../models/TapOnElementOptions";

export const ANDROID_PRE_TAP_STABLE_MATCHES_STRICT = 2;

export function androidPreTapConsecutiveStableMatchesRequired(
  _options: TapOnElementOptions,
): number {
  // Issue #6606: one successful re-find only proves the target was found once,
  // not that its bounds are stable; every selector needs consecutive samples.
  return ANDROID_PRE_TAP_STABLE_MATCHES_STRICT;
}
