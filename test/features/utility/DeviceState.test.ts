import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DeviceState,
  EMPTY_STATE_SELECTION_ERROR,
} from "../../../src/features/utility/DeviceState";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";

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

const IOS_SIMULATOR_DND_GET_COMMAND =
  "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -g com.apple.donotdisturb.enabled";
const IOS_SIMULATOR_DND_SET_ON_COMMAND =
  "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 1 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled";
const IOS_SIMULATOR_DND_SET_OFF_COMMAND =
  "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 0 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled";
const IOS_DND_INDEPENDENT_READBACK_SETTLE_MS = 500;
const IOS_BIOMETRIC_ENROLLMENT = "com.apple.BiometricKit.enrollmentChanged";
const IOS_BIOMETRIC_GET_COMMAND =
  "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -g com.apple.BiometricKit.enrollmentChanged";
const IOS_BIOMETRIC_UNENROLL_COMMAND =
  "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.BiometricKit.enrollmentChanged -s com.apple.BiometricKit.enrollmentChanged 0 -g com.apple.BiometricKit.enrollmentChanged -p com.apple.BiometricKit.enrollmentChanged";
const IOS18_BIOMETRIC_ENROLL_COMMAND =
  "spawn 7B3A3792-DB53-4654-BA94-27A1D305C3B7 notifyutil -1 com.apple.BiometricKit.enrollmentChanged -s com.apple.BiometricKit.enrollmentChanged 1 -g com.apple.BiometricKit.enrollmentChanged -p com.apple.BiometricKit.enrollmentChanged";

function autoAdvanceTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

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

  test("reads iOS <18 simulator Do Not Disturb from the legacy notifyutil key", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(IOS_SIMULATOR_DND_GET_COMMAND, "com.apple.donotdisturb.enabled 1\n");

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.getState();

    expect(result.success).toBe(true);
    expect(result.doNotDisturb).toMatchObject({
      supported: true,
      capability: "binary",
      enabled: true,
      bestEffort: true,
    });
  });

  test("reads and sets iOS Simulator biometric enrollment", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(IOS_BIOMETRIC_GET_COMMAND, `${IOS_BIOMETRIC_ENROLLMENT} 1\n`);
    simctl.setCommandResult(
      IOS_BIOMETRIC_UNENROLL_COMMAND,
      `${IOS_BIOMETRIC_ENROLLMENT} 0\n${IOS_BIOMETRIC_ENROLLMENT}\n`,
    );
    const deviceState = new DeviceState(iosSimulator, { simctl });

    const read = await deviceState.getState(["biometrics"]);
    const write = await deviceState.setState({
      biometrics: { enrollment: "not_enrolled" },
    });

    expect(read).toMatchObject({
      success: true,
      biometrics: { enrollment: "enrolled", verified: true },
    });
    expect(write).toMatchObject({
      success: true,
      biometrics: { enrollment: "not_enrolled", verified: true },
    });
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      { command: IOS_BIOMETRIC_GET_COMMAND, timeoutMs: undefined },
      { command: IOS_BIOMETRIC_UNENROLL_COMMAND, timeoutMs: 5000 },
    ]);
  });

  test("reports biometric enrollment unsupported outside iOS Simulator", async () => {
    const deviceState = new DeviceState(androidDevice);
    const result = await deviceState.setState({ biometrics: { enrollment: "enrolled" } });

    expect(result.success).toBe(false);
    expect(result.biometrics).toMatchObject({ supported: false, verified: false });
    expect(result.error).toContain("iOS Simulator");
  });

  test("retains a verified biometric result when a sibling state request fails", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      IOS18_BIOMETRIC_ENROLL_COMMAND,
      `${IOS_BIOMETRIC_ENROLLMENT} 1\n${IOS_BIOMETRIC_ENROLLMENT}\n`,
    );
    const deviceState = new DeviceState(ios18Simulator, { simctl });

    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
      biometrics: { enrollment: "enrolled" },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb?.supported).toBe(false);
    expect(result.biometrics).toMatchObject({
      enrollment: "enrolled",
      verified: true,
    });
  });

  test("reports iOS 18+ simulator Do Not Disturb read as unsupported (dead legacy key)", async () => {
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(ios18Simulator, { simctl });
    const result = await deviceState.getState();

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
    });
    expect(result.doNotDisturb?.error).toContain("donotdisturbd");
    expect(result.error).toContain("donotdisturbd");
    // No misleading `notifyutil -g` read is issued once we know the key is dead.
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
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
    const timer = autoAdvanceTimer();
    simctl.setCommandResult(IOS_SIMULATOR_DND_SET_ON_COMMAND, "com.apple.donotdisturb.enabled 1\n");
    simctl.setCommandResult(IOS_SIMULATOR_DND_GET_COMMAND, "com.apple.donotdisturb.enabled 1\n");

    const deviceState = new DeviceState(iosSimulator, { simctl, timer });
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
    expect(timer.getSleepHistory()).toEqual([IOS_DND_INDEPENDENT_READBACK_SETTLE_MS]);
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: IOS_SIMULATOR_DND_SET_ON_COMMAND,
        timeoutMs: 5000,
      },
      {
        command: IOS_SIMULATOR_DND_GET_COMMAND,
        timeoutMs: undefined,
      },
    ]);
  });

  test("reports unsupported when an independent iOS simulator DND readback reverts", async () => {
    const simctl = new FakeSimCtlClient();
    const timer = autoAdvanceTimer();
    simctl.setCommandResult(IOS_SIMULATOR_DND_SET_ON_COMMAND, "com.apple.donotdisturb.enabled 1\n");
    simctl.setCommandResult(IOS_SIMULATOR_DND_GET_COMMAND, "com.apple.donotdisturb.enabled 0\n");

    const deviceState = new DeviceState(iosSimulator, { simctl, timer });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      enabled: false,
      mode: "off",
      requestedMode: "none",
      verified: false,
      bestEffort: true,
    });
    expect(result.error).toContain("independent notifyutil readback");
    expect(result.error).toContain("donotdisturbd");
    expect(timer.getSleepHistory()).toEqual([IOS_DND_INDEPENDENT_READBACK_SETTLE_MS]);
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: IOS_SIMULATOR_DND_SET_ON_COMMAND,
        timeoutMs: 5000,
      },
      {
        command: IOS_SIMULATOR_DND_GET_COMMAND,
        timeoutMs: undefined,
      },
    ]);
  });

  test("sets iOS <18 simulator Do Not Disturb off with notifyutil best-effort commands", async () => {
    const simctl = new FakeSimCtlClient();
    const timer = autoAdvanceTimer();
    simctl.setCommandResult(
      IOS_SIMULATOR_DND_SET_OFF_COMMAND,
      "com.apple.donotdisturb.enabled 0\n",
    );
    simctl.setCommandResult(IOS_SIMULATOR_DND_GET_COMMAND, "com.apple.donotdisturb.enabled 0\n");

    const deviceState = new DeviceState(iosSimulator, { simctl, timer });
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
        command: IOS_SIMULATOR_DND_SET_OFF_COMMAND,
        timeoutMs: 5000,
      },
      {
        command: IOS_SIMULATOR_DND_GET_COMMAND,
        timeoutMs: undefined,
      },
    ]);
  });

  test("sets iOS simulator Do Not Disturb with a registered notifyutil set/read/post", async () => {
    const simctl = new FakeSimCtlClient();
    const timer = autoAdvanceTimer();
    simctl.setCommandResult(
      IOS_SIMULATOR_DND_SET_ON_COMMAND,
      "com.apple.donotdisturb.enabled 1\ncom.apple.donotdisturb.enabled\n",
    );
    simctl.setCommandResult(IOS_SIMULATOR_DND_GET_COMMAND, "com.apple.donotdisturb.enabled 1\n");

    const deviceState = new DeviceState(iosSimulator, { simctl, timer });
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
    const timer = autoAdvanceTimer();
    // notifyutil reads back enabled, but the requested *tier* cannot be applied.
    simctl.setCommandResult(IOS_SIMULATOR_DND_SET_ON_COMMAND, "com.apple.donotdisturb.enabled 1\n");
    simctl.setCommandResult(IOS_SIMULATOR_DND_GET_COMMAND, "com.apple.donotdisturb.enabled 1\n");

    const deviceState = new DeviceState(iosSimulator, { simctl, timer });
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
        command: IOS_SIMULATOR_DND_SET_ON_COMMAND,
        timeoutMs: 5000,
      },
      {
        command: IOS_SIMULATOR_DND_GET_COMMAND,
        timeoutMs: undefined,
      },
    ]);
  });

  test("reports unsupported when priority/alarms DND fails independent binary readback", async () => {
    const simctl = new FakeSimCtlClient();
    const timer = autoAdvanceTimer();
    // Fresh notifyutil reads back DISABLED even though we requested an enabled tier:
    // the binary toggle itself did not verify, on top of the tier downgrade.
    simctl.setCommandResult(IOS_SIMULATOR_DND_SET_ON_COMMAND, "com.apple.donotdisturb.enabled 1\n");
    simctl.setCommandResult(IOS_SIMULATOR_DND_GET_COMMAND, "com.apple.donotdisturb.enabled 0\n");

    const deviceState = new DeviceState(iosSimulator, { simctl, timer });
    const result = await deviceState.setState({
      doNotDisturb: { mode: "alarms" },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      enabled: false,
      mode: "off",
      requestedMode: "alarms",
      verified: false,
      bestEffort: true,
    });
    // The readback did not confirm the write, so we must NOT claim an applied
    // mode; the reported mode reflects what the readback observed (off).
    expect(result.doNotDisturb?.appliedMode).toBeUndefined();
    expect(result.doNotDisturb?.mode).toBe("off");
    expect(result.doNotDisturb?.error).toContain("independent notifyutil readback");
    expect(result.doNotDisturb?.warning).toBeUndefined();
  });

  test("surfaces simctl errors without throwing out of setState", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(IOS_SIMULATOR_DND_SET_ON_COMMAND, new Error("simctl spawn failed"));

    const deviceState = new DeviceState(iosSimulator, { simctl, timer: autoAdvanceTimer() });
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
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
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
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
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
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
  });

  test("treats iOS 26 simulators as unsupported (> last legacy-supported major)", async () => {
    const ios26Simulator: BootedDevice = {
      name: "iPhone 17 Pro",
      platform: "ios",
      deviceId: "34C35F33-224C-4E74-B8C0-668FF03E49F5",
      iosVersion: "26.2",
    };
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(ios26Simulator, { simctl });
    const result = await deviceState.setState({ doNotDisturb: { enabled: true } });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb?.capability).toBe("unsupported");
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
  });

  test("resolves the iOS major version from `osVersion` when `iosVersion` is absent", async () => {
    const osVersionOnlySimulator: BootedDevice = {
      name: "iPhone 16 Pro",
      platform: "ios",
      deviceId: "7B3A3792-DB53-4654-BA94-27A1D305C3B7",
      osVersion: "18.0",
    };
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(osVersionOnlySimulator, { simctl });
    const result = await deviceState.setState({ doNotDisturb: { enabled: true } });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb?.capability).toBe("unsupported");
    // Resolved from the device field → no live `simctl list devices` probe needed.
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("list devices"))).toBe(false);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
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
            {
              udid: "7B3A3792-DB53-4654-BA94-27A1D305C3B7",
              name: "iPhone 16 Pro",
              state: "Booted",
            },
          ],
        },
      }),
    );

    const deviceState = new DeviceState(bareSimulator, { simctl });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: true },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb?.capability).toBe("unsupported");
    // The version was resolved via the list query; still no notifyutil write.
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
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
      "com.apple.donotdisturb.enabled 1\n",
    );
    simctl.setCommandResult(
      "spawn AAAAAAAA-1111-2222-3333-444444444444 notifyutil -g com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 1\n",
    );

    const deviceState = new DeviceState(bareSimulator, { simctl, timer: autoAdvanceTimer() });
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
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(true);
  });

  test("does not claim unknown-runtime iOS DND off is verified when readback is already disabled", async () => {
    const bareSimulator: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "AAAAAAAA-1111-2222-3333-444444444444",
    };
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn AAAAAAAA-1111-2222-3333-444444444444 notifyutil -1 com.apple.donotdisturb.enabled -s com.apple.donotdisturb.enabled 0 -g com.apple.donotdisturb.enabled -p com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 0\n",
    );
    simctl.setCommandResult(
      "spawn AAAAAAAA-1111-2222-3333-444444444444 notifyutil -g com.apple.donotdisturb.enabled",
      "com.apple.donotdisturb.enabled 0\n",
    );

    const deviceState = new DeviceState(bareSimulator, { simctl, timer: autoAdvanceTimer() });
    const result = await deviceState.setState({
      doNotDisturb: { enabled: false },
    });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      enabled: false,
      mode: "off",
      requestedMode: "off",
      verified: false,
      bestEffort: true,
    });
    expect(result.error).toContain("does not prove");
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

  test("rejects an empty state selection instead of reporting a no-op success", async () => {
    const simulator: BootedDevice = {
      name: "iPhone 16 Pro",
      platform: "ios",
      deviceId: "7B3A3792-DB53-4654-BA94-27A1D305C3B7",
      iosVersion: "18.6",
    };
    const simctl = new FakeSimCtlClient();
    const deviceState = new DeviceState(simulator, { simctl });

    const result = await deviceState.getState([]);

    expect(result.success).toBe(false);
    expect(result.error).toBe(EMPTY_STATE_SELECTION_ERROR);
    expect(result.doNotDisturb).toBeUndefined();
    expect(result.biometrics).toBeUndefined();
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });
});
