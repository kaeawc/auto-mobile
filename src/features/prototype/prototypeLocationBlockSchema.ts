import { z } from "zod";

/**
 * Root `location` subscription block (#14324): keeps `/platform/location/current` up to date while
 * the prototype is shown, at most once per `minIntervalMs`. Built per call so the advertised JSON
 * schema inlines it instead of emitting a shared `$ref`.
 */
export function prototypeLocationBlockSchema() {
  return z
    .object({
      accuracy: z.enum(["precise", "approximate"]).optional(),
      minIntervalMs: z.number().finite().int().min(1000).max(3600000).optional(),
      minDistanceM: z.number().finite().min(0).max(100000).optional(),
    })
    .strict()
    .describe(
      "Foreground location updates for /platform/location/current (prototype_platform_location_v1); needs location in requires.platform and requires.permissions",
    );
}
