import { PROTOTYPE_BACKDROP_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeResult } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/**
 * Frosted backdrops (#15126): `window.backdrop {material, blur?, tint?}` blurs what is behind the
 * prototype window. Design choices, all the conservative reading of the issue's open questions:
 *
 * - `material` is a closed list. `glass` is a Liquid Glass look that exists on iOS 26+ only; every
 *   other platform draws the fallback for it.
 * - `blur` is a whole dp radius, 0 to {@link MAX_PROTOTYPE_BACKDROP_BLUR_DP}; absent means the
 *   material's own radius.
 * - `tint` is one colour (a hex or a role, no `{light, dark}` pair, so no theme-modes dependency)
 *   laid over the blur. It is the fallback colour too.
 * - Where blur is unavailable (Android below API 31, cross-window blur disabled, an app layer or
 *   system layer that cannot blur, iOS below the material's minimum) the device draws a tonal fill
 *   (`tint` at 85% alpha, else the `surfaceContainer` role at 85%), never a silent no-op, and reports
 *   `backdrop: "fallback"` in the show result. Applies to every placement and blurs the app behind
 *   the window only, never the prototype's own content.
 * - The field is gated by `prototype_backdrop_v1`: a device without it would ignore it, so the
 *   host refuses the show.
 */
export const PROTOTYPE_BACKDROP_MATERIALS = [
  "ultraThin",
  "thin",
  "regular",
  "thick",
  "glass",
] as const;
export type PrototypeBackdropMaterial = (typeof PROTOTYPE_BACKDROP_MATERIALS)[number];

export const MAX_PROTOTYPE_BACKDROP_BLUR_DP = 150;

/** What a device reports for a show that carried a `backdrop`. */
export type PrototypeBackdropOutcome = "blur" | "fallback";

/** Authored path of the backdrop, when the spec has one. */
export function prototypeBackdropFields(spec: unknown): string[] {
  return record(record(spec)?.window)?.backdrop === undefined ? [] : ["window.backdrop"];
}

export function prototypeBackdropUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_BACKDROP_CAPABILITY}, so it would ignore ${fields[0]} and draw a plain window. Nothing was shown. ${update}, or remove window.backdrop (a scrim colour on the placement still dims what is behind).`;
}

/** The device-reported outcome from a raw reply field, dropping anything but the two values. */
export function parsePrototypeBackdrop(value: unknown): { backdrop?: PrototypeBackdropOutcome } {
  return value === "blur" || value === "fallback" ? { backdrop: value } : {};
}

/** The outcome a landed show reported; absent for any other action or a device that omits it. */
export function shownBackdrop(
  action: "show" | "dismiss",
  result: PrototypeResult,
): { backdrop?: PrototypeBackdropOutcome } {
  return action === "show" && result.success ? parsePrototypeBackdrop(result.backdrop) : {};
}
