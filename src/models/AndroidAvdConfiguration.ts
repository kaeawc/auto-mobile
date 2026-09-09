import { z } from "zod/v4";

/** Persistent emulator hardware. Applied while creating an AVD, before boot. */
export const androidAvdConfigurationSchema = z
  .object({
    memoryMb: z.number().int().positive().optional(),
    cpuCores: z.number().int().min(1).max(16).optional(),
    gpuMode: z.enum(["auto", "host", "software", "swiftshader", "lavapipe", "swangle"]).optional(),
    screenWidth: z.number().int().min(240).max(7680).optional(),
    screenHeight: z.number().int().min(240).max(7680).optional(),
    screenDensity: z.number().int().min(72).max(1000).optional(),
    cameraFront: z.enum(["none", "emulated"]).optional(),
    cameraBack: z.enum(["none", "emulated"]).optional(),
    audioInput: z.boolean().optional(),
    audioOutput: z.boolean().optional(),
  })
  .strict();
export type AndroidAvdConfiguration = z.infer<typeof androidAvdConfigurationSchema>;
export const androidAvdConfigurationKeys = {
  memoryMb: "hw.ramSize",
  cpuCores: "hw.cpu.ncore",
  gpuMode: "hw.gpu.mode",
  screenWidth: "hw.lcd.width",
  screenHeight: "hw.lcd.height",
  screenDensity: "hw.lcd.density",
  cameraFront: "hw.camera.front",
  cameraBack: "hw.camera.back",
  audioInput: "hw.audioInput",
  audioOutput: "hw.audioOutput",
} as const satisfies Record<keyof AndroidAvdConfiguration, string>;
