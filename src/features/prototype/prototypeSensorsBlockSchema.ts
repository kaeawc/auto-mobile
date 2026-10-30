import { z } from "zod";

/**
 * Root `sensors` subscription block (#14327): the device listens only to the sensors listed here.
 * Continuous sensors take a `rateHz` of 1 to 30. Built per call so the advertised JSON schema
 * inlines it instead of emitting a shared `$ref`.
 */
export function prototypeSensorsBlockSchema() {
  const listen = z.object({}).strict();
  const rated = z.object({ rateHz: z.number().finite().int().min(1).max(30).optional() }).strict();
  return z
    .object({
      shake: listen.optional(),
      orientation: rated.optional(),
      steps: listen.optional(),
      proximity: listen.optional(),
      light: rated.optional(),
    })
    .strict()
    .describe(
      "Sensors the device listens to for /platform/sensors and sensors.shake (prototype_platform_sensors_v1); needs sensors in requires.platform, and steps needs the motion permission",
    );
}
