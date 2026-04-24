import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

describe("DeviceState", () => {
  test("reads Android Do Not Disturb from zen_mode", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell settings get global zen_mode", "2\n");

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.getState();

    expect(result.success).toBe(true);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      enabled: true,
      mode: "none",
      rawValue: "2",
    });
  });

  test("sets Android Do Not Disturb with cmd notification and verifies readback", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell cmd notification set_dnd priority", "");
    client.setCommandResult("shell settings get global zen_mode", "1\n");

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({
      doNotDisturb: { mode: "priority" },
    });

    expect(result.success).toBe(true);
    expect(result.doNotDisturb?.verified).toBe(true);
    expect(client.getAllCommands()).toEqual([
      "shell cmd notification set_dnd priority",
      "shell settings get global zen_mode",
    ]);
  });

  test("sets iOS simulator Do Not Disturb with notifyutil best-effort commands", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -g com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 1\n"
    );

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      enabled: true,
      mode: "none",
      bestEffort: true,
      verified: true,
    });
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -s com.apple.donotdisturb.enabled 1",
        timeoutMs: undefined,
      },
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -p com.apple.donotdisturb.enabled",
        timeoutMs: undefined,
      },
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -g com.apple.donotdisturb.enabled",
        timeoutMs: undefined,
      },
    ]);
  });

  test("reports physical iOS as unsupported for Do Not Disturb changes", async () => {
    const physicalIos: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "physical-device",
    };

    const deviceState = new DeviceState(physicalIos, { simctl: new FakeSimCtlClient() });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: false },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb?.supported).toBe(false);
    expect(result.error).toContain("iOS simulators");
  });
});
