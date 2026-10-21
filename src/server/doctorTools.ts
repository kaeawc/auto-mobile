/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from "zod/v4";
import { definePlainTool } from "./defineTool";
import { createStructuredToolResponse } from "../utils/toolUtils";
import type { IosDoctorDependencies } from "../doctor/checks/ios";
import { doctorReportSchema } from "./doctorToolOutputSchemas";
import { runDoctor } from "../doctor";

/**
 * Doctor tool arguments. `definePlainTool` applies `.strict()` (#6712) and infers the
 * handler's args from this schema.
 */
const doctorInput = z.object({
  android: z.boolean().optional().describe("Run Android-specific checks only"),
  ios: z.boolean().optional().describe("Run iOS-specific checks only"),
});

// The iOS dependencies the next doctor run uses; set by registerDoctorTools so the tool (and
// its schema) is defined once at module scope.
let iosDependencies: IosDoctorDependencies | undefined;

const doctorTool = definePlainTool({
  name: "doctor",
  description: "Run AutoMobile setup diagnostics",
  input: doctorInput,
  handler: async (args) => {
    const report = await runDoctor(
      {
        android: args.android,
        ios: args.ios,
      },
      { iosDependencies },
    );

    return createStructuredToolResponse(report);
  },
  options: { defaultEnabled: true, readOnly: true, outputSchema: doctorReportSchema },
});

/** The registered (strict) schema, for wire-contract tests. */
export const doctorSchema = doctorTool.schema;

/**
 * Register the doctor diagnostic tool
 */
export function registerDoctorTools(
  options: { iosDependencies?: IosDoctorDependencies } = {},
): void {
  iosDependencies = options.iosDependencies;
  doctorTool.register();
}
