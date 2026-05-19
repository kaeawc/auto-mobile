import { z } from "zod";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { Telephony, PhoneCallOptions, SendSmsOptions } from "../features/action/Telephony";
import { ActionableError, BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";

export const phoneCallSchema = addDeviceTargetingToSchema(z.object({
  action: z.enum(["call", "accept", "cancel", "busy", "hold"]).describe(
    "Phone call action: 'call' simulates an incoming call; 'accept' answers a ringing or waiting call; " +
    "'cancel' ends the call from the network side; 'busy' rejects a waiting call with a busy signal; " +
    "'hold' puts the active call on hold (no phoneNumber required)."
  ),
  phoneNumber: z.string().optional().describe(
    "Phone number for the call action. Required for all actions except 'hold'. " +
    "Digits with optional leading '+', max 20 digits."
  )
}));

export const sendSmsSchema = addDeviceTargetingToSchema(z.object({
  phoneNumber: z.string().describe(
    "Sender phone number for the simulated incoming SMS. Digits with optional leading '+', max 20 digits."
  ),
  message: z.string().describe(
    "SMS message body. Max 1024 characters. Must not contain newlines, carriage returns, or NUL bytes."
  )
}));

export interface PhoneCallArgs extends PhoneCallOptions {}
export interface SendSmsArgs extends SendSmsOptions {}

export function registerTelephonyTools() {
  const phoneCallHandler = async (
    device: BootedDevice,
    args: PhoneCallArgs,
    _progress?: ProgressCallback
  ) => {
    const telephony = new Telephony(device);
    const result = await telephony.phoneCall({
      action: args.action,
      phoneNumber: args.phoneNumber
    });
    if (!result.success) {
      throw new ActionableError(result.error || `Failed to execute phoneCall ${args.action}`);
    }
    return createJSONToolResponse({
      message: result.message || `Phone call ${args.action} executed`,
      ...result
    });
  };

  const sendSmsHandler = async (
    device: BootedDevice,
    args: SendSmsArgs,
    _progress?: ProgressCallback
  ) => {
    const telephony = new Telephony(device);
    const result = await telephony.sendSms({
      phoneNumber: args.phoneNumber,
      message: args.message
    });
    if (!result.success) {
      throw new ActionableError(result.error || "Failed to send simulated SMS");
    }
    return createJSONToolResponse({
      message: result.message || "Simulated SMS delivered",
      ...result
    });
  };

  ToolRegistry.registerDeviceAware(
    "phoneCall",
    "Simulate an incoming phone call on an Android emulator via the emulator console (gsm call/accept/cancel/busy/hold). " +
    "Emulator-only: physical devices return an unsupported error.",
    phoneCallSchema,
    phoneCallHandler
  );

  ToolRegistry.registerDeviceAware(
    "sendSms",
    "Send a simulated incoming SMS to an Android emulator via the emulator console (sms send). " +
    "Emulator-only: physical devices return an unsupported error.",
    sendSmsSchema,
    sendSmsHandler
  );
}
