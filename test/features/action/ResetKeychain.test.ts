import { describe, expect, test } from "bun:test";
import { ResetKeychain } from "../../../src/features/action/ResetKeychain";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const simulatorDevice: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

const physicalDevice: BootedDevice = {
  name: "Jason's iPhone",
  platform: "ios",
  deviceId: "00008110-0012345678901234",
};

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

const APP_ID = "com.example.app";

describe("ResetKeychain", () => {
  test("iOS Simulator resets the WHOLE device and reports it exceeded the requested appId scope", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetKeychain(simulatorDevice, simctl);

    const result = await action.execute({ appId: APP_ID, confirm: true, explicitlyTargeted: true });

    expect(result.success).toBe(true);
    expect(result.deviceId).toBe(simulatorDevice.deviceId);
    expect(result.platform).toBe("ios");
    expect(result.requestedAppId).toBe(APP_ID);
    // Device-wide reset over-scopes the per-app request: this must be reported honestly.
    expect(result.scope).toBe("all-apps");
    expect(result.exceededRequestedScope).toBe(true);
    // The message must not claim it cleared only the requested app's data.
    expect(result.message).toContain("EVERY app's Keychain data");
    expect(result.message).toContain(APP_ID);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: ["keychain", "12345678-1234-1234-1234-123456789ABC", "reset"],
        timeoutMs: undefined,
      },
    ]);
  });

  test("refuses to run against an ambiently-resolved device (no explicit target) and issues no command", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetKeychain(simulatorDevice, simctl);

    const promise = action.execute({ appId: APP_ID, confirm: true, explicitlyTargeted: false });
    await expect(promise).rejects.toBeInstanceOf(ActionableError);
    await expect(promise).rejects.toThrow(/explicit device target/);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("refuses to run without explicit confirmation and issues no command", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetKeychain(simulatorDevice, simctl);

    await expect(
      action.execute({ appId: APP_ID, confirm: false, explicitlyTargeted: true }),
    ).rejects.toBeInstanceOf(ActionableError);
    await expect(
      action.execute({ appId: APP_ID, confirm: false, explicitlyTargeted: true }),
    ).rejects.toThrow(/confirm: true/);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("rejects physical iOS devices before execution (scoped reset tracked in #5188)", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetKeychain(physicalDevice, simctl);

    await expect(
      action.execute({ appId: APP_ID, confirm: true, explicitlyTargeted: true }),
    ).rejects.toThrow(/#5188/);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("rejects Android devices before execution (scoped Keystore reset tracked in #5190)", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetKeychain(androidDevice, simctl);

    await expect(
      action.execute({ appId: APP_ID, confirm: true, explicitlyTargeted: true }),
    ).rejects.toThrow(/#5190/);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("surfaces tooling unavailability as an ActionableError", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["keychain", "12345678-1234-1234-1234-123456789ABC", "reset"],
      new Error("simctl is not available. Please install Xcode command line tools to continue."),
    );
    const action = new ResetKeychain(simulatorDevice, simctl);

    const promise = action.execute({ appId: APP_ID, confirm: true, explicitlyTargeted: true });
    await expect(promise).rejects.toBeInstanceOf(ActionableError);
    await expect(promise).rejects.toThrow(/simctl is not available/);
  });

  test("propagates command failures as an ActionableError", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["keychain", "12345678-1234-1234-1234-123456789ABC", "reset"],
      new Error("Invalid device state"),
    );
    const action = new ResetKeychain(simulatorDevice, simctl);

    const promise = action.execute({ appId: APP_ID, confirm: true, explicitlyTargeted: true });
    await expect(promise).rejects.toBeInstanceOf(ActionableError);
    await expect(promise).rejects.toThrow(/Failed to reset the iOS Simulator Keychain/);
  });
});
