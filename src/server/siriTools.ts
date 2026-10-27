import { z } from "zod/v4";
import { DefaultDeviceServicePreflight } from "../utils/deviceServicePreflight";
import {
  ActivateSiri,
  SIRI_PHRASE_MAX_LENGTH,
  SIRI_PHRASE_PATTERN,
  type ActivateSiriResult,
} from "../features/action/ActivateSiri";
import type { BootedDevice } from "../models";
import type { ProgressCallback } from "../features/action/BaseVisualChange";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool, type DeviceToolSchema } from "./defineTool";
import { siriResultSchema } from "./siriToolOutputSchemas";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const siriInput = z.object({
  phrase: z
    .string()
    .trim()
    .min(1)
    .max(SIRI_PHRASE_MAX_LENGTH)
    .regex(SIRI_PHRASE_PATTERN, "siri phrase cannot contain control characters")
    .describe(
      'What the user would say to Siri, e.g. an App Shortcut phrase "Show my orders in Playground"',
    ),
});

export type SiriArgs = z.output<DeviceToolSchema<typeof siriInput>>;

export interface SiriToolDependencies {
  siriFactory?: (device: BootedDevice) => Pick<ActivateSiri, "execute">;
}

function statusOf(result: ActivateSiriResult): "activated" | "unsupported" | "failed" {
  if (result.success) {
    return "activated";
  }
  return result.unsupported ? "unsupported" : "failed";
}

export function createSiriHandler(deps: SiriToolDependencies = {}) {
  const siriFactory =
    deps.siriFactory ??
    ((device: BootedDevice) =>
      new ActivateSiri(device, null, undefined, {
        servicePreflight: new DefaultDeviceServicePreflight(),
      }));
  return async (
    device: BootedDevice,
    args: SiriArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const result = await siriFactory(device).execute(args.phrase, { progress, signal });
    const status = statusOf(result);
    const response = createStructuredToolResponse({
      message: result.success
        ? `Sent "${result.phrase}" to Siri. The runner cannot confirm Siri is enabled: if nothing happened, enable Siri in the simulator Settings.`
        : (result.error ?? "Siri activation failed"),
      ...result,
      status,
      deviceId: device.deviceId,
      platform: device.platform,
    });
    return status === "failed" ? { ...response, isError: true as const } : response;
  };
}

const siriTool = defineDeviceTool({
  name: "siri",
  description:
    "iOS: activate Siri with a spoken phrase (XCUIDevice.siriService), e.g. to invoke an App Shortcut / App Intent, then return the observation. Android returns unsupported.",
  input: siriInput,
  options: {
    // A plan step that invokes an App Shortcut and checks where it lands.
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: siriResultSchema,
  },
});

export function registerSiriTools(deps: SiriToolDependencies = {}): void {
  siriTool.register(undefined, createSiriHandler(deps));
}
