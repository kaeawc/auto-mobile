import { expect, describe, test, beforeEach } from "bun:test";
import { Telephony } from "../../../src/features/action/Telephony";
import { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeEmulatorConsoleClient } from "../../fakes/FakeEmulatorConsoleClient";
import { FakeIosSdkTriggerSender } from "../../fakes/FakeIosSdkTriggerSender";

const iosDevice = {
  deviceId: "00008101-001C711E0EE0001E",
  platform: "ios",
  name: "iPhone",
} as BootedDevice;

describe("Telephony", () => {
  let adb: FakeAdbExecutor;
  let consoleClient: FakeEmulatorConsoleClient;
  let device: BootedDevice;
  let telephony: Telephony;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell getprop ro.kernel.qemu", { stdout: "1", stderr: "" });

    consoleClient = new FakeEmulatorConsoleClient();
    device = { deviceId: "emulator-5554", platform: "android", name: "Pixel_5" } as BootedDevice;
    telephony = new Telephony(device, adb, () => consoleClient);
  });

  describe("phoneCall", () => {
    test("call action dispatches gsmCall on the emulator console", async () => {
      const result = await telephony.phoneCall({ action: "call", phoneNumber: "+15551234567" });

      expect(result.success).toBe(true);
      expect(result.action).toBe("call");
      expect(result.phoneNumber).toBe("+15551234567");
      expect(result.supported).toBe(true);
      expect(consoleClient.calls).toEqual([{ method: "gsmCall", args: ["+15551234567"] }]);
    });

    test("accept/cancel/busy actions each route to their corresponding console command", async () => {
      await telephony.phoneCall({ action: "accept", phoneNumber: "5551234567" });
      await telephony.phoneCall({ action: "cancel", phoneNumber: "5551234567" });
      await telephony.phoneCall({ action: "busy", phoneNumber: "5551234567" });

      expect(consoleClient.calls.map((c) => c.method)).toEqual([
        "gsmAccept",
        "gsmCancel",
        "gsmBusy",
      ]);
    });

    test("hold action does not require a phoneNumber", async () => {
      const result = await telephony.phoneCall({ action: "hold" });

      expect(result.success).toBe(true);
      expect(consoleClient.calls).toEqual([{ method: "gsmHold", args: [] }]);
    });

    test("call/accept/cancel/busy without phoneNumber return a validation error without contacting the console", async () => {
      const result = await telephony.phoneCall({ action: "call" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("phoneNumber is required");
      expect(consoleClient.calls.length).toBe(0);
    });

    test("iOS never contacts the emulator console", async () => {
      const sender = new FakeIosSdkTriggerSender();
      telephony = new Telephony(
        iosDevice,
        adb,
        () => consoleClient,
        () => sender,
      );

      const result = await telephony.phoneCall({ action: "call", phoneNumber: "5551234567" });

      expect(result.success).toBe(true);
      expect(consoleClient.calls.length).toBe(0);
    });

    test("returns supported:false for a physical Android device (non-emulator serial)", async () => {
      device = { deviceId: "HT85N1A02890", platform: "android", name: "Pixel" } as BootedDevice;
      telephony = new Telephony(device, adb, () => consoleClient);

      const result = await telephony.phoneCall({ action: "call", phoneNumber: "5551234567" });

      expect(result.success).toBe(false);
      expect(result.supported).toBe(false);
      expect(result.error).toContain("does not appear to be an Android emulator");
      expect(consoleClient.calls.length).toBe(0);
    });

    test("returns supported:false when ro.kernel.qemu is not '1' even for emulator-NNNN serials", async () => {
      adb.setCommandResponse("shell getprop ro.kernel.qemu", { stdout: "", stderr: "" });

      const result = await telephony.phoneCall({ action: "call", phoneNumber: "5551234567" });

      expect(result.success).toBe(false);
      expect(result.supported).toBe(false);
      expect(consoleClient.calls.length).toBe(0);
    });

    test("surfaces emulator console failures in the result", async () => {
      consoleClient.failNext(
        "gsmCall",
        new Error("Emulator console rejected command: invalid number"),
      );

      const result = await telephony.phoneCall({ action: "call", phoneNumber: "5551234567" });

      expect(result.success).toBe(false);
      expect(result.supported).toBe(true);
      expect(result.error).toContain("invalid number");
    });
  });

  describe("sendSms", () => {
    test("delivers a simulated SMS via the emulator console", async () => {
      const result = await telephony.sendSms({
        phoneNumber: "+15551234567",
        message: "Hello, world!",
      });

      expect(result.success).toBe(true);
      expect(result.phoneNumber).toBe("+15551234567");
      expect(result.messageLength).toBe("Hello, world!".length);
      expect(consoleClient.calls).toEqual([
        { method: "smsSend", args: ["+15551234567", "Hello, world!"] },
      ]);
    });

    test("returns supported:false on physical devices", async () => {
      device = { deviceId: "HT85N1A02890", platform: "android", name: "Pixel" } as BootedDevice;
      telephony = new Telephony(device, adb, () => consoleClient);

      const result = await telephony.sendSms({ phoneNumber: "5551234567", message: "hi" });

      expect(result.success).toBe(false);
      expect(result.supported).toBe(false);
      expect(consoleClient.calls.length).toBe(0);
    });

    test("surfaces validation errors from the emulator console client", async () => {
      consoleClient.failNext(
        "smsSend",
        new Error("SMS message must not contain newline, carriage return, or NUL characters."),
      );

      const result = await telephony.sendSms({ phoneNumber: "5551234567", message: "anything" });

      expect(result.success).toBe(false);
      expect(result.supported).toBe(true);
      expect(result.error).toContain("must not contain newline");
    });

    test("uses port from the device serial when constructing the console client", async () => {
      let receivedPort = -1;
      device = { deviceId: "emulator-5560", platform: "android", name: "Pixel_5" } as BootedDevice;
      telephony = new Telephony(device, adb, (port) => {
        receivedPort = port;
        return consoleClient;
      });

      await telephony.sendSms({ phoneNumber: "5551234567", message: "hi" });

      expect(receivedPort).toBe(5560);
    });
  });

  describe("iOS via the in-app SDK trigger route (#1580)", () => {
    let sender: FakeIosSdkTriggerSender;

    beforeEach(() => {
      sender = new FakeIosSdkTriggerSender();
      telephony = new Telephony(
        iosDevice,
        adb,
        () => consoleClient,
        () => sender,
      );
    });

    test("each phoneCall action maps to the callkit trigger of the same name", async () => {
      for (const action of ["call", "accept", "cancel", "busy"] as const) {
        const result = await telephony.phoneCall({ action, phoneNumber: "+15551234567" });
        expect(result).toMatchObject({ success: true, supported: true, action });
        expect(result.message).toContain("CallKit");
      }
      const hold = await telephony.phoneCall({ action: "hold" });
      expect(hold.success).toBe(true);

      expect(sender.requests).toEqual([
        { module: "callkit", trigger: "call", payload: { phoneNumber: "+15551234567" } },
        { module: "callkit", trigger: "accept", payload: { phoneNumber: "+15551234567" } },
        { module: "callkit", trigger: "cancel", payload: { phoneNumber: "+15551234567" } },
        { module: "callkit", trigger: "busy", payload: { phoneNumber: "+15551234567" } },
        { module: "callkit", trigger: "hold" },
      ]);
    });

    test("phoneNumber is still required except for hold, before any trigger", async () => {
      const result = await telephony.phoneCall({ action: "accept" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("phoneNumber is required for action 'accept'");
      expect(sender.requests).toEqual([]);
    });

    test("sendSms maps to the messages module's sms trigger", async () => {
      const result = await telephony.sendSms({ phoneNumber: "5551234567", message: "hello" });
      expect(result).toMatchObject({ success: true, supported: true, messageLength: 5 });
      expect(sender.requests).toEqual([
        {
          module: "messages",
          trigger: "sms",
          payload: { phoneNumber: "5551234567", message: "hello" },
        },
      ]);
    });

    test("sendSms rejects bodies the Android console path rejects, without reaching the SDK", async () => {
      for (const message of ["", "a\nb", "a\rb", "a\0b", "x".repeat(1025)]) {
        const result = await telephony.sendSms({ phoneNumber: "555", message });
        expect(result.success).toBe(false);
        expect(result.supported).toBe(true);
        expect(result.error).toContain("SMS message");
      }
      expect(sender.requests).toEqual([]);
    });

    test("an app without the SDK returns an actionable unsupported error", async () => {
      sender.result = {
        success: false,
        available: false,
        totalTimeMs: 0,
        error:
          "The foreground app does not embed the AutoMobile in-app SDK with sdk-trigger support.",
      };
      const call = await telephony.phoneCall({ action: "call", phoneNumber: "555" });
      const sms = await telephony.sendSms({ phoneNumber: "555", message: "hi" });

      for (const result of [call, sms]) {
        expect(result.success).toBe(false);
        expect(result.supported).toBe(false);
        expect(result.error).toContain(
          "requires the app under test to embed the AutoMobile iOS SDK",
        );
      }
      expect(call.error).toStartWith("phoneCall on iOS");
      expect(sms.error).toStartWith("sendSms on iOS");
    });

    test("an SDK without the callkit module names the registered modules", async () => {
      sender.result = {
        success: false,
        available: true,
        statusCode: 404,
        sdkError: "module_not_registered",
        registeredModules: ["biometrics", "messages"],
        totalTimeMs: 0,
      };
      const result = await telephony.phoneCall({ action: "call", phoneNumber: "555" });
      expect(result.supported).toBe(true);
      expect(result.error).toContain(
        "no 'callkit' trigger module (registered: biometrics, messages)",
      );
    });

    test("a CallKit rejection carries the SDK's reason", async () => {
      sender.result = {
        success: false,
        available: true,
        statusCode: 409,
        sdkError: "trigger_failed",
        reason: "no_call_for_number",
        totalTimeMs: 0,
      };
      const result = await telephony.phoneCall({ action: "accept", phoneNumber: "555" });
      expect(result.error).toBe(
        "phoneCall on iOS failed in the app's AutoMobile SDK: no_call_for_number.",
      );
    });

    test("an older runner without request_sdk_trigger asks for a runner update", async () => {
      sender.result = {
        success: false,
        available: false,
        unsupported: true,
        totalTimeMs: 0,
        error: "Unknown command type: request_sdk_trigger",
      };
      const result = await telephony.sendSms({ phoneNumber: "555", message: "hi" });
      expect(result.error).toContain("runner that supports request_sdk_trigger");
    });

    test("a thrown runner error becomes a typed failure", async () => {
      sender.error = new Error("socket closed");
      const result = await telephony.phoneCall({ action: "hold" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("socket closed");
    });
  });
});
