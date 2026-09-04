import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DeviceState,
  EMPTY_STATE_SELECTION_ERROR,
  NETWORK_CONDITION_PROFILES,
} from "../../../src/features/utility/DeviceState";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

// iOS 17 simulator. DND is unsupported here too (issue #2862) — this fixture now
// only exercises the still-working biometric-enrollment notifyutil path.
const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  iosVersion: "17.5",
};

// iOS 18+ simulator: DND is owned by donotdisturbd, so the write path must honestly
// report unsupported instead of posting a non-authoritative legacy notification.
const ios18Simulator: BootedDevice = {
  name: "iPhone 16 Pro",
  platform: "ios",
  deviceId: "7B3A3792-DB53-4654-BA94-27A1D305C3B7",
  iosVersion: "18.6",
};

const IOS_BIOMETRIC_ENROLLMENT = "com.apple.BiometricKit.enrollmentChanged";
const IOS_BIOMETRIC_GET_COMMAND =
  "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -g com.apple.BiometricKit.enrollmentChanged";
const IOS_BIOMETRIC_UNENROLL_COMMAND =
  "spawn 12345678-1234-1234-1234-123456789ABC notifyutil -1 com.apple.BiometricKit.enrollmentChanged -s com.apple.BiometricKit.enrollmentChanged 0 -g com.apple.BiometricKit.enrollmentChanged -p com.apple.BiometricKit.enrollmentChanged";
const IOS18_BIOMETRIC_ENROLL_COMMAND =
  "spawn 7B3A3792-DB53-4654-BA94-27A1D305C3B7 notifyutil -1 com.apple.BiometricKit.enrollmentChanged -s com.apple.BiometricKit.enrollmentChanged 1 -g com.apple.BiometricKit.enrollmentChanged -p com.apple.BiometricKit.enrollmentChanged";

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

  test("reads iOS simulator Do Not Disturb as unsupported without issuing a notifyutil read", async () => {
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.getState();

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
    });
    // A `notifyutil -g` read would report `0` regardless of the real Focus
    // state, so it is not issued at all.
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
  });

  test("reports iOS simulator DND priority/alarms as unsupported, not a silent downgrade", async () => {
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(iosSimulator, { simctl });
    const result = await deviceState.setState({ doNotDisturb: { mode: "priority" } });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedMode: "priority",
      verified: false,
    });
    // No applied tier is claimed, and no write is posted.
    expect(result.doNotDisturb?.appliedMode).toBeUndefined();
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
  });

  // Previously an unresolvable iOS version fell through to the legacy
  // best-effort write. donotdisturbd owns the key on every runtime Xcode can
  // install, so an unknown version must report unsupported rather than post a
  // notification that cannot take effect.
  test("reports unsupported for an iOS simulator whose version cannot be resolved", async () => {
    const unknownVersionSimulator: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "12345678-1234-1234-1234-123456789ABC",
    };
    const simctl = new FakeSimCtlClient();

    const deviceState = new DeviceState(unknownVersionSimulator, { simctl });
    const result = await deviceState.setState({ doNotDisturb: { enabled: true } });

    expect(result.success).toBe(false);
    expect(result.doNotDisturb).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedMode: "none",
      verified: false,
    });
    const commands = simctl.getMethodCalls("executeCommand").map((c) => c.command as string);
    expect(commands.some((c) => c.includes("notifyutil"))).toBe(false);
    // No version probe is needed either — the answer no longer depends on it.
    expect(commands.some((c) => c.includes("list devices"))).toBe(false);
  });

  // Empirically verified on booted simulators for issue #2862, `donotdisturbd`
  // running in each: on **iOS 16.4 (20E247)** and **iOS 17.5 (21F79)** a value
  // posted with the production `notifyutil -1 -s -g -p` shape reads back as `0`
  // from a fresh process, while an unmanaged control key set the same way
  // persists as `1` — matching the already-recorded iOS 18.x/26.x behavior. The
  // old `<= 17` legacy fast-path was therefore wrong at every testable version.
  test("reports DND unsupported without a simctl call for every iOS simulator major", async () => {
    for (const iosVersion of ["16.4", "17.5", "18.6", "26.2"]) {
      const simctl = new FakeSimCtlClient();
      const deviceState = new DeviceState({ ...iosSimulator, iosVersion }, { simctl });

      const read = await deviceState.getState();
      const write = await deviceState.setState({ doNotDisturb: { enabled: true } });

      expect(read.doNotDisturb?.capability).toBe("unsupported");
      expect(write.doNotDisturb?.capability).toBe("unsupported");
      expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
    }
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

  test("applies a documented degraded profile via the emulator console (3g)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "3g" } });

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "full",
      method: "android_emulator_console",
      requestedProfile: "3g",
      appliedProfile: "3g",
      verified: true,
      values: NETWORK_CONDITION_PROFILES["3g"],
    });
    expect(client.getAllCommands()).toEqual([
      "emu gsm data on",
      "emu network delay umts",
      "emu network speed umts",
    ]);
  });

  test("takes the device offline by turning the data radio off", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "offline" } });

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      appliedProfile: "offline",
      verified: true,
    });
    expect(client.getAllCommands()).toEqual(["emu gsm data off"]);
  });

  test("cancels/resets a network condition back to normal connectivity", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { cancel: true } });

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      appliedProfile: "none",
      verified: true,
    });
    expect(client.getAllCommands()).toEqual([
      "emu network delay none",
      "emu network speed full",
      "emu gsm data on",
    ]);
  });

  test("honors explicit numeric overrides over the profile's named specs", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({
      networkCondition: { profile: "3g", delayMs: 250, downloadKbps: 1000, uploadKbps: 400 },
    });

    expect(result.success).toBe(true);
    expect(result.networkCondition?.values).toMatchObject({
      delayMs: 250,
      downloadKbps: 1000,
      uploadKbps: 400,
    });
    expect(client.getAllCommands()).toEqual([
      "emu gsm data on",
      "emu network delay 250:250",
      "emu network speed 400:1000",
    ]);
  });

  test("reports a failed emulator console command as unverified", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("emu network delay umts", "", "KO: bad delay");

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "3g" } });

    expect(result.success).toBe(false);
    expect(result.networkCondition?.supported).toBe(true);
    expect(result.networkCondition?.error).toContain("KO");
  });

  test("reads back the emulator network status for the selected device", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(
      "emu network status",
      "Current network status:\n  download speed: 0 bits/s\n",
    );

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.getState(["networkCondition"]);

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "full",
      method: "android_emulator_console",
      verified: true,
    });
    expect(result.networkCondition?.rawStatus).toContain("network status");
    expect(client.getAllCommands()).toEqual(["emu network status"]);
  });

  test("reports network conditioning unsupported on a physical Android device", async () => {
    const physicalAndroid: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "38290DLJG000XY",
    };
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(physicalAndroid, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "3g" } });

    expect(result.success).toBe(false);
    expect(result.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedProfile: "3g",
      verified: false,
    });
    expect(result.networkCondition?.error).toContain("emulator");
    // No emulator console command is ever issued on a physical device.
    expect(client.getAllCommands()).toEqual([]);
  });

  test("reports network conditioning unsupported on an iOS simulator", async () => {
    const simctl = new FakeSimCtlClient();
    const deviceState = new DeviceState(iosSimulator, { simctl });

    const set = await deviceState.setState({ networkCondition: { profile: "3g" } });
    const get = await deviceState.getState(["networkCondition"]);

    expect(set.success).toBe(false);
    expect(set.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedProfile: "3g",
      verified: false,
    });
    expect(get.networkCondition).toMatchObject({ supported: false, capability: "unsupported" });
    expect(set.networkCondition?.error).toContain("iOS");
    // No simctl command is issued for an unsupported concern.
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
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
