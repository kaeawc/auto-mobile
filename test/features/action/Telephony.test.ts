import { expect, describe, test, beforeEach } from "bun:test";
import { Telephony } from "../../../src/features/action/Telephony";
import { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeEmulatorConsoleClient } from "../../fakes/FakeEmulatorConsoleClient";

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

    test("returns supported:false on iOS devices", async () => {
      device = {
        deviceId: "00008101-001C711E0EE0001E",
        platform: "ios",
        name: "iPhone",
      } as BootedDevice;
      telephony = new Telephony(device, adb, () => consoleClient);

      const result = await telephony.phoneCall({ action: "call", phoneNumber: "5551234567" });

      expect(result.success).toBe(false);
      expect(result.supported).toBe(false);
      expect(result.error).toContain("only supported on Android emulators");
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
});
