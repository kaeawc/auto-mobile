import { describe, it, expect } from "bun:test";
import { disableStylusHandwriting } from "../../src/utils/disableStylusHandwriting";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import type { BootedDevice } from "../../src/models";

function makeDevice(overrides: Partial<BootedDevice> = {}): BootedDevice {
  return {
    name: "emulator-5554",
    deviceId: "emulator-5554",
    platform: "android",
    ...overrides,
  };
}

describe("disableStylusHandwriting", () => {
  it("disables stylus handwriting on an Android emulator", async () => {
    const factory = new FakeAdbClientFactory();
    const device = makeDevice();

    await disableStylusHandwriting(device, factory);

    const calls = factory.getFakeClient().getCommandCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("shell settings put secure stylus_handwriting_enabled 0");
  });

  it("skips iOS devices", async () => {
    const factory = new FakeAdbClientFactory();
    const device = makeDevice({ platform: "ios", deviceId: "ABCD-1234" });

    await disableStylusHandwriting(device, factory);

    expect(factory.getFakeClient().getCommandCalls()).toHaveLength(0);
  });

  it("skips physical Android devices", async () => {
    const factory = new FakeAdbClientFactory();
    const device = makeDevice({ deviceId: "R5CR1234567" });

    await disableStylusHandwriting(device, factory);

    expect(factory.getFakeClient().getCommandCalls()).toHaveLength(0);
  });

  it("does not throw when ADB command fails", async () => {
    const factory = new FakeAdbClientFactory();
    factory
      .getFakeClient()
      .setCommandError(
        "shell settings put secure stylus_handwriting_enabled 0",
        new Error("device offline"),
      );
    const device = makeDevice();

    await expect(disableStylusHandwriting(device, factory)).resolves.toBeUndefined();
  });
});
