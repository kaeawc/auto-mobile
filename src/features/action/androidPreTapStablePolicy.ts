import type { TapOnElementOptions } from "../../models/TapOnElementOptions";

export const ANDROID_PRE_TAP_STABLE_MATCHES_STRICT = 2;

export function androidPreTapConsecutiveStableMatchesRequired(
  options: TapOnElementOptions,
): number {
  return options.sibling === true ? ANDROID_PRE_TAP_STABLE_MATCHES_STRICT : 1;
}
