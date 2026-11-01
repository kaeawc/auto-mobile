import { z } from "zod/v4";
import { watchRotateCrown } from "../features/watch/WatchActions";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool, type DeviceToolHandler } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const rotateCrownInput = z.object({
  platform: z.literal("watchos").optional().describe("Apple Watch only"),
  delta: z
    .number()
    .finite()
    .refine((value) => value !== 0, "delta must not be zero")
    .describe("Signed, non-zero Digital Crown rotation delta"),
  velocity: z
    .number()
    .finite()
    .positive()
    .optional()
    .describe("Positive Digital Crown rotation velocity (default: 1)"),
});

export const rotateCrownHandler: DeviceToolHandler<typeof rotateCrownInput> = async (
  device,
  args,
  _progress,
  signal,
) => createStructuredToolResponse(await watchRotateCrown(device, args, signal));

const rotateCrownTool = defineDeviceTool({
  name: "rotateCrown",
  description:
    "watchOS only: rotate the Apple Watch Digital Crown by a signed, non-zero delta, with optional positive velocity (default: 1). Target an Apple Watch session. Observe afterward to check the app's response.",
  input: rotateCrownInput,
  handler: rotateCrownHandler,
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: z.object({ success: z.boolean(), delta: z.number(), velocity: z.number() }),
  },
});

export const rotateCrownSchema = rotateCrownTool.schema;

export function registerRotateCrownTools(): void {
  rotateCrownTool.register();
}
