/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import { runDoctor } from "../doctor";

/**
 * Schema for the doctor tool
 */
export const doctorSchema = z
  .object({
    android: z.boolean().optional().describe("Run Android-specific checks only"),
    ios: z.boolean().optional().describe("Run iOS-specific checks only"),
    deviceId: z
      .string()
      .min(1)
      .optional()
      .describe("Restrict device-specific checks to one selected device identifier"),
  })
  .strict();

/**
 * Arguments for the doctor tool
 */
export interface DoctorArgs {
  android?: boolean;
  ios?: boolean;
  deviceId?: string;
}

/**
 * Register the doctor diagnostic tool
 */
export function registerDoctorTools(): void {
  ToolRegistry.register(
    "doctor",
    "Run AutoMobile setup diagnostics",
    doctorSchema,
    async (args: DoctorArgs) => {
      const report = await runDoctor({
        android: args.android,
        ios: args.ios,
        deviceId: args.deviceId,
      });

      return createJSONToolResponse(report);
    },
    { defaultEnabled: true },
  );
}
