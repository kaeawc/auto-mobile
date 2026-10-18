import type { DeviceLockState } from "../../models";

/** First `<field>=true|false` match as a boolean, or null when the field is absent. */
function matchBool(haystack: string, pattern: RegExp): boolean | null {
  const match = haystack.match(pattern);
  return match ? match[1] === "true" : null;
}

/**
 * Parse `adb shell dumpsys window policy` into a device-lock signal.
 *
 * Lowercase, boundary-anchored tokens: the KeyguardServiceDelegate fields are
 * `showing=`/`occluded=`/`secure=`, which do not collide with the CamelCase
 * siblings in the same dump (`mKeyguardOccluded=`, `mSimSecure=`, `mIsShowing=`).
 *
 * `locked` is `showing && !occluded`. A dump missing the keyguard `showing` field yields
 * `null` (unknown); a missing `secure` field yields `secure: undefined` rather than a guess.
 */
export function parseDeviceLock(policy: string): DeviceLockState | null {
  const keyguardShowing = matchBool(policy, /(?:^|\s)showing=(true|false)/);
  if (keyguardShowing === null) {
    return null;
  }
  const occluded = matchBool(policy, /(?:^|\s)occluded=(true|false)/) ?? false;
  const secure = matchBool(policy, /(?:^|\s)secure=(true|false)/);
  return {
    locked: keyguardShowing && !occluded,
    keyguardShowing,
    secure: secure ?? undefined,
  };
}
