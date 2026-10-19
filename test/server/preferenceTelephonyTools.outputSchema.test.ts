import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readToolResponse } from "../helpers/toolResponse";
import { registerPreferenceTools } from "../../src/server/preferenceTools";
import {
  getPreferenceResultSchema,
  setPreferenceResultSchema,
} from "../../src/server/preferenceToolOutputSchemas";
import { createPhoneCallHandler, createSendSmsHandler } from "../../src/server/telephonyTools";
import {
  phoneCallResultSchema,
  sendSmsResultSchema,
} from "../../src/server/telephonyToolOutputSchemas";
import { registerTelephonyTools } from "../../src/server/telephonyTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { Telephony } from "../../src/features/action/Telephony";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeIosSdkTriggerSender } from "../fakes/FakeIosSdkTriggerSender";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "android" };

const preferenceResult = {
  success: true,
  deviceId: "fake-device",
  platform: "android" as const,
  scope: "sharedPreferences" as const,
  appId: "com.example.app",
  suite: "prefs",
  key: "k",
  value: "v",
  type: "string",
  found: true,
  verified: true,
};

const iosDevice: BootedDevice = { deviceId: "sim-1", name: "iPhone", platform: "ios" };
const makeTelephony = (target: BootedDevice) =>
  new Telephony(target, new FakeAdbExecutor(), undefined, () => new FakeIosSdkTriggerSender());

function textOf(response: { content: Array<{ type: string; text?: string }> }): string {
  const block = response.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text result");
  }
  return block.text;
}

describe("preference and telephony output schemas (#11830)", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerPreferenceTools({
      appPreferencesFactory: () => ({
        getPreference: async () => preferenceResult,
        setPreference: async () => preferenceResult,
      }),
    });
    registerTelephonyTools();
  });
  afterEach(() => ToolRegistry.clearTools());

  test.each([
    ["getPreference", getPreferenceResultSchema],
    ["setPreference", setPreferenceResultSchema],
    ["phoneCall", phoneCallResultSchema],
    ["sendSms", sendSmsResultSchema],
  ] as const)("%s declares its outputSchema", (name, schema) => {
    const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
      (candidate) => candidate.name === name,
    );
    expect(tool?.outputSchema).toBe(schema);
  });

  test.each(["getPreference", "setPreference"] as const)(
    "%s keeps the text payload and validates structuredContent",
    async (name) => {
      const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
        (candidate) => candidate.name === name,
      );
      const response = readToolResponse(
        await tool!.deviceAwareHandler!(device, {
          ...preferenceResult,
          value: "v",
          type: "string",
        }),
      );
      expect(JSON.parse(textOf(response))).toEqual(preferenceResult);
      expect(getPreferenceResultSchema.safeParse(response.structuredContent).success).toBe(true);
    },
  );

  test("phoneCall keeps the text payload and validates structuredContent", async () => {
    const response = await createPhoneCallHandler(makeTelephony)(iosDevice, {
      action: "call",
      phoneNumber: "5551234567",
    });
    expect(JSON.parse(textOf(response))).toEqual(
      JSON.parse(JSON.stringify(response.structuredContent)),
    );
    expect(phoneCallResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("sendSms keeps the text payload and validates structuredContent", async () => {
    const response = await createSendSmsHandler(makeTelephony)(iosDevice, {
      phoneNumber: "5551234567",
      message: "hi",
    });
    expect(JSON.parse(textOf(response))).toEqual(
      JSON.parse(JSON.stringify(response.structuredContent)),
    );
    expect(sendSmsResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });
});
