import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { Telephony, PhoneCallOptions, SendSmsOptions } from "../features/action/Telephony";
import { ActionableError, BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";

// #6712: the advertised `additionalProperties: false` was not enforced at
// runtime — a plain z.object silently DROPPED an undeclared caller argument.
// `.strict()` closes that gap, matching launchApp/tapOn (#6154) and the
// preference tools (#6348).
export const phoneCallSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z
        .enum(["call", "accept", "cancel", "busy", "hold"])
        .describe("call/accept/cancel/busy/hold; hold needs no phoneNumber"),
      phoneNumber: z.string().optional().describe("Phone number; required except for hold"),
    })
    .strict(),
);

export const sendSmsSchema = addDeviceTargetingToSchema(
  z
    .object({
      phoneNumber: z.string().describe("Sender phone number"),
      message: z.string().describe("SMS body; max 1024 chars, no newlines/NUL"),
    })
    .strict(),
);

export interface PhoneCallArgs extends PhoneCallOptions {}
export interface SendSmsArgs extends SendSmsOptions {}

/** Builds the Telephony a handler drives; injectable so tests substitute fakes. */
export type TelephonyFactory = (device: BootedDevice) => Telephony;

const defaultTelephonyFactory: TelephonyFactory = (device) => new Telephony(device);

// Exported so the typed-failure -> ActionableError mapping can be unit-tested
// directly against a Telephony result (issue #4181, rank 4b). iOS routes to the
// in-app SDK trigger route (#1580); tests inject a Telephony with a fake sender.
export const createPhoneCallHandler =
  (makeTelephony: TelephonyFactory = defaultTelephonyFactory) =>
  async (device: BootedDevice, args: PhoneCallArgs, _progress?: ProgressCallback) => {
    const telephony = makeTelephony(device);
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

export const phoneCallHandler = createPhoneCallHandler();

export const createSendSmsHandler =
  (makeTelephony: TelephonyFactory = defaultTelephonyFactory) =>
  async (device: BootedDevice, args: SendSmsArgs, _progress?: ProgressCallback) => {
    const telephony = makeTelephony(device);
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

export const sendSmsHandler = createSendSmsHandler();

export function registerTelephonyTools() {
  ToolRegistry.registerDeviceAware(
    "phoneCall",
    "Simulate a phone call: Android emulator gsm commands, or CallKit via the app's AutoMobile iOS SDK.",
    phoneCallSchema,
    phoneCallHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "sendSms",
    "Send simulated incoming SMS: Android emulator, or a notification via the app's AutoMobile iOS SDK.",
    sendSmsSchema,
    sendSmsHandler,
    { defaultEnabled: false },
  );
}
