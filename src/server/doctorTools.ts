/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import type { IosDoctorDependencies } from "../doctor/checks/ios";
import { runDoctor } from "../doctor";

/**
 * Schema for the doctor tool
 */
export const doctorSchema = z
  .object({
    android: z.boolean().optional().describe("Run Android-specific checks only"),
    ios: z.boolean().optional().describe("Run iOS-specific checks only"),
  })
  .strict();

/**
 * Arguments for the doctor tool
 */
export interface DoctorArgs {
  android?: boolean;
  ios?: boolean;
}

/**
 * Register the doctor diagnostic tool
 */
export function registerDoctorTools(
  options: { iosDependencies?: IosDoctorDependencies } = {},
): void {
  ToolRegistry.register(
    "doctor",
    "Run AutoMobile setup diagnostics",
    doctorSchema,
    async (args: DoctorArgs) => {
      const report = await runDoctor(
        {
          android: args.android,
          ios: args.ios,
        },
        { iosDependencies: options.iosDependencies },
      );

      return createJSONToolResponse(report);
    },
    { defaultEnabled: true, readOnly: true },
  );
}
