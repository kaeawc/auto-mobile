import { z } from "zod/v4";
import {
  deviceResourceDescriptions,
  type ConfigurableDeviceResource,
} from "./deviceResourceDescriptions";

/** Caller-carried receipt, bound to one boot/user. Contains no arbitrary commands. */
export const androidResourceRestorationSchema = z
  .object({
    deviceId: z.string(),
    bootId: z.string().uuid(),
    userId: z.number().int().nonnegative(),
    entries: z
      .array(
        z
          .object({
            resource: z.enum(
              Object.keys(deviceResourceDescriptions) as [
                ConfigurableDeviceResource,
                ...ConfigurableDeviceResource[],
              ],
            ),
            target: z.string(),
            kind: z.enum(["package", "global", "secure", "backup"]),
            value: z.string().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type AndroidResourceRestoration = z.infer<typeof androidResourceRestorationSchema>;
