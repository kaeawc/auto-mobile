import { prototypeScrollEdgeEffectFields } from "./prototypeGlass";
import type { PrototypePlatformNote } from "./prototypePlatformNotes";

/** Older iOS still advertises edge effects, so disclose the gradient approximation. */
export function prototypeGlassEdgeNotes(
  spec: unknown,
  platform: "ios" | "android",
  osMajor?: number,
): PrototypePlatformNote[] {
  if (platform !== "ios" || osMajor === undefined || osMajor >= 26) {
    return [];
  }
  const paths = prototypeScrollEdgeEffectFields(spec);
  return paths.length
    ? [
        {
          platform,
          construct: "scroll.edgeEffect",
          effect: "substituted",
          paths: paths.slice(0, 20),
          ...(paths.length > 20 ? { total: paths.length } : {}),
          detail:
            "Scroll edge effects use a scrollability-aware gradient fade on iOS before 26 (soft 24 dp, hard 8 dp; fadeEdges overrides lengths; none disables the mask).",
        },
      ]
    : [];
}
