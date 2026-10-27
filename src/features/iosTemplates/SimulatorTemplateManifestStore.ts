import {
  PREBOOT_LEAN_PROFILES,
  type PrebootLeanProfileName,
} from "../../utils/ios-cmdline-tools/SimulatorPrebootProfile";
import { IOS_SIMULATOR_UUID_PATTERN } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { z } from "zod";
import type { SimulatorTemplateKey } from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
export const templateManifestSchema = z
  .object({
    key: z.object({
      runtime: z.string(),
      runtimeBuild: z.string(),
      xcodeBuild: z.string(),
      deviceType: z.string(),
      profile: z.enum(
        Object.keys(PREBOOT_LEAN_PROFILES) as [PrebootLeanProfileName, ...PrebootLeanProfileName[]],
      ),
    }),
    udid: z.union([z.literal(""), z.string().regex(IOS_SIMULATOR_UUID_PATTERN)]),
    state: z.enum(["building", "ready", "failed", "stale"]),
    xcodeBuild: z.string(),
    runtimeBuild: z.string(),
    builtAtMs: z.number(),
    settledAtMs: z.number().optional(),
    failure: z.object({ atMs: z.number(), reason: z.string() }).optional(),
    attempt: z.number().int().nonnegative().optional(),
    nextAttemptAtMs: z.number().optional(),
  })
  .refine((manifest) => manifest.state !== "ready" || manifest.udid !== "", {
    message: "Ready templates require a simulator UDID",
  });
export type SimulatorTemplateManifest = z.infer<typeof templateManifestSchema>;
export interface SimulatorTemplateManifestStore {
  read(key: SimulatorTemplateKey): Promise<SimulatorTemplateManifest | undefined>;
  write(manifest: SimulatorTemplateManifest): Promise<void>;
  remove(key: SimulatorTemplateKey): Promise<void>;
  removeInvalid?(runtime?: string): Promise<void>;
  list(): Promise<SimulatorTemplateManifest[]>;
}
