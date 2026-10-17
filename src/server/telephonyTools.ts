import { z } from "zod/v4";
import { Telephony } from "../features/action/Telephony";
import { ActionableError, BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";

// #6712: the advertised `additionalProperties: false` was not enforced at
// runtime. `defineDeviceTool` applies `.strict()` and device targeting, so the
// handler args below are inferred from these schemas (no hand-written Args).
const phoneCallInput = z.object({
  action: z
    .enum(["call", "accept", "cancel", "busy", "hold"])
    .describe("call/accept/cancel/busy/hold; hold needs no phoneNumber"),
  phoneNumber: z.string().optional().describe("Phone number; required except for hold"),
});

const sendSmsInput = z.object({
  phoneNumber: z.string().describe("Sender phone number"),
  message: z.string().describe("SMS body; max 1024 chars, no newlines/NUL"),
});

type PhoneCallArgs = z.output<typeof phoneCallInput>;
type SendSmsArgs = z.output<typeof sendSmsInput>;

/** Builds the Telephony a handler drives; injectable so tests substitute fakes. */
export type TelephonyFactory = (device: BootedDevice) => Telephony;

const defaultTelephonyFactory: TelephonyFactory = (device) => new Telephony(device);

// Exported so the typed-failure -> ActionableError mapping can be unit-tested
// directly against a Telephony result (issue #4181, rank 4b). iOS routes to the
// in-app SDK trigger route (#1580); tests inject a Telephony with a fake sender.
export const createPhoneCallHandler =
  (makeTelephony: TelephonyFactory = defaultTelephonyFactory) =>
  async (device: BootedDevice, args: PhoneCallArgs) => {
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
  async (device: BootedDevice, args: SendSmsArgs) => {
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

const phoneCallTool = defineDeviceTool({
  name: "phoneCall",
  description:
    "Simulate a phone call: Android emulator gsm commands, or CallKit via the app's AutoMobile iOS SDK.",
  input: phoneCallInput,
  handler: phoneCallHandler,
  options: { defaultEnabled: false },
});

const sendSmsTool = defineDeviceTool({
  name: "sendSms",
  description:
    "Send simulated incoming SMS: Android emulator, or a notification via the app's AutoMobile iOS SDK.",
  input: sendSmsInput,
  handler: sendSmsHandler,
  options: { defaultEnabled: false },
});

export const phoneCallSchema = phoneCallTool.schema;
export const sendSmsSchema = sendSmsTool.schema;

export function registerTelephonyTools() {
  phoneCallTool.register();
  sendSmsTool.register();
}
