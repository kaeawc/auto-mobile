import { z } from "zod/v4";
import { prototypePlatformModuleFields } from "./prototypePlatformGates";

/**
 * `show platformMode` for the `share` module (#19308). Real system share sheets are not available
 * yet, so a spec that uses or declares `share` is shown only in fake mode: a runtime's fake share
 * module resolves the payload and answers `share.open` with `{outcome: "shared", simulated: true}`
 * or the outcome queued with `simulate call: "share.open"`. Pure, so the host refuses before any
 * device is asked.
 */

export const PROTOTYPE_PLATFORM_MODE_VALUES = ["real", "fake"] as const;
export type PrototypePlatformModeValue = (typeof PROTOTYPE_PLATFORM_MODE_VALUES)[number];

export const prototypePlatformModeSchema = z.strictObject({
  share: z.enum(PROTOTYPE_PLATFORM_MODE_VALUES).optional(),
});
export type PrototypePlatformMode = z.output<typeof prototypePlatformModeSchema>;

/** The refusal for a show whose share use and `platformMode.share` disagree, or undefined. */
export function prototypeSharePlatformModeRefusal(
  spec: unknown,
  platformMode: PrototypePlatformMode | undefined,
): string | undefined {
  const mode = platformMode?.share ?? "real";
  const fields = prototypePlatformModuleFields(spec, "share");
  if (fields.length === 0) {
    return platformMode?.share === undefined
      ? undefined
      : `platformMode.share applies only to a spec that declares share in requires.platform. Add it or omit platformMode.share. Nothing was shown.`;
  }
  if (mode === "fake") {
    return undefined;
  }
  return `The share platform module at ${fields.join(", ")} has no real system share sheet yet. Show it with platformMode: {share: "fake"}: share.open then resolves {outcome: "shared", simulated: true}, or the outcome queued with prototype simulate call "share.open". Nothing was shown.`;
}
