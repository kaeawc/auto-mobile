import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { Telephony, PhoneCallOptions, SendSmsOptions } from "../features/action/Telephony";
import { ActionableError, BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";

export const phoneCallSchema = addDeviceTargetingToSchema(
  z.object({
    action: z
      .enum(["call", "accept", "cancel", "busy", "hold"])
      .describe("call/accept/cancel/busy/hold; hold needs no phoneNumber"),
    phoneNumber: z.string().optional().describe("Phone number; required except for hold"),
  }),
);

export const sendSmsSchema = addDeviceTargetingToSchema(
  z.object({
    phoneNumber: z.string().describe("Sender phone number"),
    message: z.string().describe("SMS body; max 1024 chars, no newlines/NUL"),
  }),
);

export interface PhoneCallArgs extends PhoneCallOptions {}
export interface SendSmsArgs extends SendSmsOptions {}

// Exported so the typed-failure -> ActionableError mapping can be unit-tested
// directly against a Telephony result (issue #4181, rank 4b). A non-Android
// device yields a typed failure with no network access.
export const phoneCallHandler = async (
  device: BootedDevice,
  args: PhoneCallArgs,
  _progress?: ProgressCallback,
) => {
  const telephony = new Telephony(device);
  const result = await telephony.phoneCall({
    action: args.action,
    phoneNumber: args.phoneNumber,
  });
  if (!result.success) {
    throw new ActionableError(result.error || `Failed to execute phoneCall ${args.action}`);
  }
  return createJSONToolResponse({
    message: result.message || `Phone call ${args.action} executed`,
    ...result,
  });
};

export const sendSmsHandler = async (
  device: BootedDevice,
  args: SendSmsArgs,
  _progress?: ProgressCallback,
) => {
  const telephony = new Telephony(device);
  const result = await telephony.sendSms({
    phoneNumber: args.phoneNumber,
    message: args.message,
  });
  if (!result.success) {
    throw new ActionableError(result.error || "Failed to send simulated SMS");
  }
  return createJSONToolResponse({
    message: result.message || "Simulated SMS delivered",
    ...result,
  });
};

export function registerTelephonyTools() {
  ToolRegistry.registerDeviceAware(
    "phoneCall",
    "Simulate Android emulator phone call via gsm commands.",
    phoneCallSchema,
    phoneCallHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "sendSms",
    "Send simulated incoming SMS on Android emulator.",
    sendSmsSchema,
    sendSmsHandler,
    { defaultEnabled: false },
  );
}
