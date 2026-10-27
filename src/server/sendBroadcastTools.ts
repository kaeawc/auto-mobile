import { z } from "zod/v4";
import { androidIntentFields } from "../features/intent/androidIntent";
import { SendBroadcast, type SendBroadcastResult } from "../features/intent/SendBroadcast";
import type { BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool, type DeviceToolSchema } from "./defineTool";
import { sendBroadcastResultSchema } from "./sendBroadcastToolOutputSchemas";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const sendBroadcastInput = z.object({
  appId: z.string().min(1).describe("Target package: the broadcast is always explicit to it"),
  intent: z
    .object({ ...androidIntentFields, action: z.string().min(1).describe("Broadcast action") })
    .strict(),
  userId: z.number().int().min(0).optional().describe("Android user to deliver to"),
  waitForResult: z
    .boolean()
    .optional()
    .describe("Report the ordered-broadcast result code and data (default true)"),
});

export type SendBroadcastArgs = z.output<DeviceToolSchema<typeof sendBroadcastInput>>;

export type SendBroadcastAdbFactory = (device: BootedDevice) => Pick<AdbExecutor, "execute">;

function describe(result: SendBroadcastResult, appId: string, action: string): string {
  return result.delivered
    ? `Broadcast ${action} delivered to ${appId} (result ${result.resultCode})`
    : result.error;
}

export function createSendBroadcastHandler(
  adbFor: SendBroadcastAdbFactory = (device) => defaultAdbClientFactory.create(device),
) {
  return async (
    device: BootedDevice,
    args: SendBroadcastArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      return createStructuredToolResponse({
        message: "sendBroadcast is Android-only: iOS has no broadcast intents.",
        success: false,
        status: "unsupported" as const,
        delivered: false,
        deviceId: device.deviceId,
        appId: args.appId,
      });
    }
    const result = await new SendBroadcast(adbFor(device)).send(
      { appId: args.appId, intent: args.intent, userId: args.userId },
      signal,
    );
    const reported =
      result.delivered && args.waitForResult === false
        ? { delivered: true as const, output: result.output }
        : result;
    const response = createStructuredToolResponse({
      message: describe(result, args.appId, args.intent.action),
      success: result.delivered,
      status: result.delivered ? ("delivered" as const) : ("failed" as const),
      deviceId: device.deviceId,
      appId: args.appId,
      ...reported,
    });
    return result.delivered ? response : { ...response, isError: true as const };
  };
}

const sendBroadcastTool = defineDeviceTool({
  name: "sendBroadcast",
  description:
    "Android: send an explicit broadcast to the app under test (its package, or one of its receivers) with a typed intent (action, data, categories, typed extras), e.g. to toggle a debug flag or seed data. Reports the ordered-broadcast result; protected system broadcasts are refused with a typed error.",
  input: sendBroadcastInput,
  options: {
    // A plan step: the broadcast changes app state the following steps rely on.
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: sendBroadcastResultSchema,
  },
});

export function registerSendBroadcastTools(adbFor?: SendBroadcastAdbFactory): void {
  sendBroadcastTool.register(undefined, createSendBroadcastHandler(adbFor));
}
