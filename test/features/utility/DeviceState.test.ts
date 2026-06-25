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
      capability: "full",
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
    expect(result.doNotDisturb?.capability).toBe("full");
    expect(result.doNotDisturb?.verified).toBe(true);
    expect(client.getAllCommands()).toEqual([
      "shell cmd notification set_dnd priority",
      "shell settings get global zen_mode",
    ]);
  });

  test("sets iOS simulator Do Not Disturb on with notifyutil best-effort commands", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 1\n"
    );

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      capability: "binary",
      enabled: true,
      mode: "none",
      requestedMode: "none",
      appliedMode: "none",
      bestEffort: true,
      verified: true,
    });
    expect(result.doNotDisturb?.warning).toBeUndefined();
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
        timeoutMs: 5000,
      },
    ]);
  });

  test("sets iOS simulator Do Not Disturb off with notifyutil best-effort commands", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 0 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 0\n"
    );

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: false },
    });

    expect(result.success).toBe(true);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      capability: "binary",
      enabled: false,
      mode: "off",
      requestedMode: "off",
      appliedMode: "off",
      bestEffort: true,
      verified: true,
    });
    expect(result.doNotDisturb?.warning).toBeUndefined();
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 0 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
        timeoutMs: 5000,
      },
    ]);
  });

  test("sets iOS simulator Do Not Disturb with a temporary notifyutil registration", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 1\ncom.apple.donotdisturb.enabled\n"
    );

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      enabled: true,
      requestedMode: "none",
      appliedMode: "none",
      verified: true,
    });
  });

  test("reports honest downgrade for iOS simulator priority/alarms (no silent tier claim)", async () => {
    const simctl = new FakeSimCtlClient();
    // notifyutil reads back enabled, but the requested *tier* cannot be applied.
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 1\n"
    );

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { mode: "priority" },
    });

    // Honest contract: the requested tier was NOT applied, so success is false.
    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      capability: "binary",
      enabled: true,
      mode: "none",
      requestedMode: "priority",
      appliedMode: "none",
      bestEffort: true,
      verified: false,
    });
    expect(result.doNotDisturb?.warning).toContain("binary");
    expect(result.doNotDisturb?.warning).toContain("priority");
    // We still posted the binary toggle (a DND state was applied, just not the tier).
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
        timeoutMs: 5000,
      },
    ]);
  });

  test("surfaces both the downgrade and a failed binary readback for iOS priority/alarms", async () => {
    const simctl = new FakeSimCtlClient();
    // notifyutil reads back DISABLED even though we requested an enabled tier:
    // the binary toggle itself did not verify, on top of the tier downgrade.
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 0\n"
    );

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { mode: "alarms" },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      capability: "binary",
      requestedMode: "alarms",
      verified: false,
      bestEffort: true,
    });
    // The readback did not confirm the write, so we must NOT claim an applied
    // mode; the reported mode reflects what the readback observed (off).
    expect(result.doNotDisturb?.appliedMode).toBeUndefined();
    expect(result.doNotDisturb?.mode).toBe("off");
    // The warning must NOT claim plain DND was applied — the readback failed.
    expect(result.doNotDisturb?.warning).toContain("alarms");
    expect(result.doNotDisturb?.warning).toContain("did not read back");
    expect(result.doNotDisturb?.warning).not.toContain("applied as plain DND");
  });

  test("surfaces simctl errors without throwing out of setState", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      new Error("simctl spawn failed")
    );

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      capability: "binary",
      requestedMode: "none",
      bestEffort: true,
      method: "ios_simulator_notifyutil",
    });
    expect(result.doNotDisturb?.error).toContain("simctl spawn failed");
    expect(result.error).toContain("simctl spawn failed");
  });

  test("reports physical iOS as unsupported with a precise no-public-API error", async () => {
    const physicalIos: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "00008110-000A4D8E0C01401E",
    };

    const simctl = new FakeSimCtlClient();
    const deviceState = new DeviceState(physicalIos, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: false },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedMode: "off",
    });
    expect(result.error).toContain("no public API");
    expect(result.error).toContain("Focus Filter API");
    // Early return: no simctl/notifyutil command was ever issued.
    expect(simctl.getMethodCalls("executeCommand")).toEqual([]);
  });
});
