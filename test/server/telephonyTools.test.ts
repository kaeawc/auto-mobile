import { describe, expect, test } from "bun:test";
import {
  createPhoneCallHandler,
  createSendSmsHandler,
  phoneCallHandler,
  phoneCallSchema,
  sendSmsSchema,
} from "../../src/server/telephonyTools";
import { ActionableError, BootedDevice } from "../../src/models";
import { Telephony } from "../../src/features/action/Telephony";
import { FakeIosSdkTriggerSender } from "../fakes/FakeIosSdkTriggerSender";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

// telephonyTools.ts had ZERO test mentions repo-wide (issue #4181, rank 4b).
// The handlers map a failed Telephony result to an ActionableError. iOS routes
// to the in-app SDK trigger route (#1580) through an injected fake sender, so
// the mapping is exercised with no sockets, no timers, no real device.
const iosDevice: BootedDevice = { name: "iPhone", deviceId: "sim-1", platform: "ios" };
const androidDevice: BootedDevice = {
  name: "Pixel",
  deviceId: "emulator-5554",
  platform: "android",
};

function iosHandlers(sender: FakeIosSdkTriggerSender) {
  const makeTelephony = (device: BootedDevice) =>
    new Telephony(device, new FakeAdbExecutor(), undefined, () => sender);
  return {
    phoneCall: createPhoneCallHandler(makeTelephony),
    sendSms: createSendSmsHandler(makeTelephony),
  };
}

const noSdk = {
  success: false,
  available: false,
  totalTimeMs: 0,
  error: "The foreground app does not embed the AutoMobile in-app SDK with sdk-trigger support.",
};

describe("telephonyTools handlers", () => {
  test("phoneCall raises ActionableError when the iOS app lacks the SDK", async () => {
    const sender = new FakeIosSdkTriggerSender();
    sender.result = noSdk;
    const { phoneCall } = iosHandlers(sender);
    const pending = phoneCall(iosDevice, { action: "call", phoneNumber: "5551234567" });
    await expect(pending).rejects.toBeInstanceOf(ActionableError);
    await expect(
      phoneCall(iosDevice, { action: "call", phoneNumber: "5551234567" }),
    ).rejects.toThrow("requires the app under test to embed the AutoMobile iOS SDK");
  });

  test("phoneCall raises ActionableError when phoneNumber is missing for a non-hold action", async () => {
    // Android + no phoneNumber returns a typed failure before any client is
    // resolved, so still no network.
    await expect(phoneCallHandler(androidDevice, { action: "call" })).rejects.toThrow(
      "phoneNumber is required for action 'call'",
    );
  });

  test("sendSms raises ActionableError when the iOS app lacks the SDK", async () => {
    const sender = new FakeIosSdkTriggerSender();
    sender.result = noSdk;
    const { sendSms } = iosHandlers(sender);
    await expect(
      sendSms(iosDevice, { phoneNumber: "5551234567", message: "hi" }),
    ).rejects.toBeInstanceOf(ActionableError);
  });

  test("iOS success returns the SDK delivery result", async () => {
    const sender = new FakeIosSdkTriggerSender();
    const { phoneCall, sendSms } = iosHandlers(sender);
    const call = await phoneCall(iosDevice, { action: "call", phoneNumber: "5551234567" });
    const sms = await sendSms(iosDevice, { phoneNumber: "5551234567", message: "hi" });
    expect(JSON.stringify(call)).toContain("CallKit");
    expect(JSON.stringify(sms)).toContain("SMS-style notification");
    expect(sender.requests.map((request) => `${request.module}.${request.trigger}`)).toEqual([
      "callkit.call",
      "messages.sms",
    ]);
  });
});

describe("telephonyTools schemas", () => {
  test("phoneCall schema accepts every advertised action", () => {
    for (const action of ["call", "accept", "cancel", "busy", "hold"] as const) {
      expect(phoneCallSchema.parse({ action, phoneNumber: "5551234567" }).action).toBe(action);
    }
  });

  test("phoneCall schema rejects an unknown action", () => {
    expect(() => phoneCallSchema.parse({ action: "text", phoneNumber: "5551234567" })).toThrow();
  });

  test("sendSms schema requires both phoneNumber and message", () => {
    expect(() => sendSmsSchema.parse({ phoneNumber: "5551234567" })).toThrow();
    expect(() => sendSmsSchema.parse({ message: "hi" })).toThrow();
    expect(sendSmsSchema.parse({ phoneNumber: "5551234567", message: "hi" }).message).toBe("hi");
  });

  // The sendSms message field is advertised as "max 1024 chars, no newlines/NUL"
  // but is a bare z.string() with NO runtime enforcement. These rows PIN the
  // present (permissive) behavior so a future tightening of the schema is a
  // visible, deliberate change rather than a silent one. The NUL row uses the
  // escape sequence "a\0b" — never a literal NUL byte (issue #4339).
  test("sendSms schema does NOT enforce its advertised message constraints", () => {
    const overLong = "x".repeat(2000);
    expect(
      sendSmsSchema.parse({ phoneNumber: "5551234567", message: overLong }).message.length,
    ).toBe(2000);
    expect(
      sendSmsSchema.parse({ phoneNumber: "5551234567", message: "line1\nline2" }).message,
    ).toBe("line1\nline2");
    expect(sendSmsSchema.parse({ phoneNumber: "5551234567", message: "a\0b" }).message).toBe(
      "a\0b",
    );
  });

  test("sendSms schema description advertises the unenforced constraints", () => {
    // Documents the mismatch: the description promises constraints the schema
    // never validates. If enforcement is added, this description assertion and
    // the permissive rows above should be updated together.
    const json = sendSmsSchema.parse({ phoneNumber: "5551234567", message: "hi" });
    expect(json).toBeDefined();
    const messageDescription =
      (sendSmsSchema as unknown as { shape?: { message?: { description?: string } } }).shape
        ?.message?.description ?? "";
    expect(messageDescription).toContain("no newlines/NUL");
  });
});
