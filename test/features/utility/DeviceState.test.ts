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

// iOS < 18 simulator: the legacy notifyutil binary-DND path still applies.
const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  iosVersion: "17.5",
};

// iOS 18+ simulator: DND moved to donotdisturbd, so the write path must honestly
// report unsupported instead of posting a non-authoritative legacy notification.
const ios18Simulator: BootedDevice = {
  name: "iPhone 16 Pro",
  platform: "ios",
  deviceId: "7B3A3792-DB53-4654-BA94-27A1D305C3B7",
  iosVersion: "18.6",
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

  test("sets iOS <18 simulator Do Not Disturb on with notifyutil best-effort commands", async () => {
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

  test("sets iOS <18 simulator Do Not Disturb off with notifyutil best-effort commands", async () => {
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

  test("reports iOS 18+ simulator DND enable as unsupported without issuing a notifyutil write", async () => {
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(ios18Simulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedMode: "none",
      verified: false,
    });
    // Honest, actionable reason: DND moved to donotdisturbd; no public setter.
    expect(result.doNotDisturb?.error).toContain("donotdisturbd");
    expect(result.doNotDisturb?.error).toContain("iOS 18");
    expect(result.doNotDisturb?.error).toContain("no public API");
    expect(result.error).toContain("donotdisturbd");
    // Critically: no misleading notifyutil command was ever posted.
    const commands = simctl.getMethodCalls("executeCommand").map(c => c.command as string);
    expect(commands.some(c => c.includes("notifyutil"))).toBe(false);
  });

  test("reports iOS 18+ simulator DND disable as unsupported without issuing a notifyutil write", async () => {
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(ios18Simulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: false },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedMode: "off",
      verified: false,
    });
    const commands = simctl.getMethodCalls("executeCommand").map(c => c.command as string);
    expect(commands.some(c => c.includes("notifyutil"))).toBe(false);
  });

  test("reports iOS 18+ simulator priority/alarms DND as unsupported", async () => {
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(ios18Simulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { mode: "priority" },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedMode: "priority",
      verified: false,
    });
    const commands = simctl.getMethodCalls("executeCommand").map(c => c.command as string);
    expect(commands.some(c => c.includes("notifyutil"))).toBe(false);
  });

  test("resolves iOS 18+ live via `simctl list devices` when the device omits iosVersion", async () => {
    const bareSimulator: BootedDevice = {
      name: "iPhone 16 Pro",
      platform: "ios",
      deviceId: "7B3A3792-DB53-4654-BA94-27A1D305C3B7",
    };
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "list devices 7B3A3792-DB53-4654-BA94-27A1D305C3B7 --json",
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
            { udid: "7B3A3792-DB53-4654-BA94-27A1D305C3B7", name: "iPhone 16 Pro", state: "Booted" },
          ],
        },
      })
    );

    const deviceState = new DeviceState(bareSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb?.capability).toBe("unsupported");
    // The version was resolved via the list query; still no notifyutil write.
    const commands = simctl.getMethodCalls("executeCommand").map(c => c.command as string);
    expect(commands.some(c => c.includes("notifyutil"))).toBe(false);
    expect(commands).toContain("list devices 7B3A3792-DB53-4654-BA94-27A1D305C3B7 --json");
  });

  test("falls back to the legacy notifyutil path when the iOS version cannot be resolved", async () => {
    const bareSimulator: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "AAAAAAAA-1111-2222-3333-444444444444",
    };
    const simctl = new FakeSimCtlClient();
    // No iosVersion on the device and the list query returns nothing usable →
    // unknown version → attempt the legacy path rather than over-refusing.
    simctl.setCommandResult(
      "spawn AAAAAAAA-1111-2222-3333-444444444444 notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 1\n"
    );

    const deviceState = new DeviceState(bareSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      capability: "binary",
      enabled: true,
      verified: true,
    });
    const commands = simctl.getMethodCalls("executeCommand").map(c => c.command as string);
    expect(commands.some(c => c.includes("notifyutil"))).toBe(true);
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
