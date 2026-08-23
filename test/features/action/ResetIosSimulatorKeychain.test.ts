import { describe, expect, test } from "bun:test";
import { ResetIosSimulatorKeychain } from "../../../src/features/action/ResetIosSimulatorKeychain";
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

describe("ResetIosSimulatorKeychain", () => {
  test("constructs `simctl keychain <udid> reset` when confirmed", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetIosSimulatorKeychain(simulatorDevice, simctl);

    const result = await action.execute({ confirm: true });

    expect(result.success).toBe(true);
    expect(result.deviceId).toBe(simulatorDevice.deviceId);
    expect(result.platform).toBe("ios");
    expect(result.scope).toBe("all-apps");
    // The result must not claim it clears only one app's data.
    expect(result.message).toContain("Every app's Keychain data");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: ["keychain", "12345678-1234-1234-1234-123456789ABC", "reset"],
        timeoutMs: undefined,
      },
    ]);
  });

  test("refuses to run without explicit confirmation and issues no command", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetIosSimulatorKeychain(simulatorDevice, simctl);

    await expect(action.execute({ confirm: false })).rejects.toBeInstanceOf(ActionableError);
    await expect(action.execute({ confirm: false })).rejects.toThrow(/confirm: true/);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("rejects physical iOS devices before execution", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetIosSimulatorKeychain(physicalDevice, simctl);

    await expect(action.execute({ confirm: true })).rejects.toThrow(/only supported on simulators/);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("rejects non-iOS devices before execution", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new ResetIosSimulatorKeychain(androidDevice, simctl);

    await expect(action.execute({ confirm: true })).rejects.toThrow(
      /only supported on iOS simulators/,
    );
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("surfaces tooling unavailability as an ActionableError", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["keychain", "12345678-1234-1234-1234-123456789ABC", "reset"],
      new Error("simctl is not available. Please install Xcode command line tools to continue."),
    );
    const action = new ResetIosSimulatorKeychain(simulatorDevice, simctl);

    const promise = action.execute({ confirm: true });
    await expect(promise).rejects.toBeInstanceOf(ActionableError);
    await expect(promise).rejects.toThrow(/simctl is not available/);
  });

  test("propagates command failures as an ActionableError", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["keychain", "12345678-1234-1234-1234-123456789ABC", "reset"],
      new Error("Invalid device state"),
    );
    const action = new ResetIosSimulatorKeychain(simulatorDevice, simctl);

    const promise = action.execute({ confirm: true });
    await expect(promise).rejects.toBeInstanceOf(ActionableError);
    await expect(promise).rejects.toThrow(/Failed to reset the iOS Simulator Keychain/);
  });
});
