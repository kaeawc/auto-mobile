import { z } from "zod/v4";
import { EMULATOR_SENSOR_NAMES } from "../features/utility/EmulatorSensors";

/** Failures throw, so a `setSensor` result always describes a completed call. */
export const setSensorResultSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    deviceId: z.string(),
    sensor: z.enum(EMULATOR_SENSOR_NAMES),
    applied: z.array(z.number()),
    previous: z.array(z.number()),
    changed: z.boolean(),
    reset: z.boolean(),
    restore: z
      .object({
        value: z.array(z.number()),
        onSessionRelease: z.boolean(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
