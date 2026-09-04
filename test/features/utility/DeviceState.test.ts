import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DeviceState,
  EMPTY_STATE_SELECTION_ERROR,
  NETWORK_CONDITION_PROFILES,
  classifyNetworkConditionRequest,
  networkConditionInputDegrades,
  networkConditionInputError,
  networkConditionInputIsRequest,
  parseEmulatorNetworkStatus,
  type SetNetworkConditionInput,
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

  test("applies a documented degraded profile with VALID delay/speed presets (3g)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "3g" } });

    // A degrade is reported `partial`, never a false `verified: true`: the console
    // shapes only the cellular interface and Wi-Fi disable is best-effort.
    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "partial",
      method: "android_emulator_console",
      requestedProfile: "3g",
      appliedProfile: "3g",
      values: NETWORK_CONDITION_PROFILES["3g"],
    });
    expect(result.networkCondition?.verified).toBeUndefined();
    expect(result.networkCondition?.warning).toContain("cellular");
    // `umts` is a valid preset for BOTH network delay and network speed.
    expect(client.getAllCommands()).toEqual([
      "emu gsm data on",
      "emu network delay umts",
      "emu network speed umts",
      "shell svc wifi disable",
    ]);
  });

  test("uses valid delay presets for veryBad/4g (gsm/lte/full are speed-only)", async () => {
    const cases: Array<{ profile: "veryBad" | "4g"; delay: string; speed: string }> = [
      { profile: "veryBad", delay: "gprs", speed: "gsm" },
      { profile: "4g", delay: "none", speed: "lte" },
    ];
    for (const { profile, delay, speed } of cases) {
      const adbFactory = new FakeAdbClientFactory();
      const client = adbFactory.getFakeClient();
      const deviceState = new DeviceState(androidDevice, { adbFactory });

      await deviceState.setState({ networkCondition: { profile } });

      const commands = client.getAllCommands();
      // The delay spec must be a valid `network delay` preset (gprs/edge/umts/none).
      expect(commands).toContain(`emu network delay ${delay}`);
      expect(commands).toContain(`emu network speed ${speed}`);
      // Guard against the regression: no speed-only preset reaches `network delay`.
      expect(commands).not.toContain("emu network delay gsm");
      expect(commands).not.toContain("emu network delay lte");
      expect(commands).not.toContain("emu network delay full");
      expect(commands).not.toContain("emu network delay hsdpa");
    }
  });

  test("takes the device offline (cellular cut + best-effort Wi-Fi disable, reported partial)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "offline" } });

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "partial",
      appliedProfile: "offline",
    });
    // Honest: offline is NOT reported verified, because Wi-Fi may keep the link up.
    expect(result.networkCondition?.verified).toBeUndefined();
    expect(result.networkCondition?.warning).toContain("cellular");
    expect(client.getAllCommands()).toEqual(["emu gsm data off", "shell svc wifi disable"]);
  });

  test("cancels/resets a network condition back to normal connectivity (re-enables Wi-Fi)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { cancel: true } });

    // Reset is the safe restore direction, so it is fully applied and verified.
    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "full",
      appliedProfile: "none",
      verified: true,
    });
    expect(client.getAllCommands()).toEqual([
      "emu network delay none",
      "emu network speed full",
      "emu gsm data on",
      "shell svc wifi enable",
    ]);
  });

  test("discards shaping overrides when cancel/reset is set (no latency leak)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({
      networkCondition: { cancel: true, delayMs: 500, downloadKbps: 10 },
    });

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      capability: "full",
      appliedProfile: "none",
      verified: true,
    });
    expect(result.networkCondition?.warning).toContain("ignored");
    // The override does NOT become a `500:500` delay — reset clears shaping.
    expect(client.getAllCommands()).toEqual([
      "emu network delay none",
      "emu network speed full",
      "emu gsm data on",
      "shell svc wifi enable",
    ]);
  });

  test("#6090: `none` + neutral (zero) overrides is a clean reset that re-enables Wi-Fi", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({
      networkCondition: { profile: "none", delayMs: 0, downloadKbps: 0, uploadKbps: 0 },
    });

    // Neutral overrides carry no shaping, so this is a reset, not a degrade: it
    // must re-enable Wi-Fi (`svc wifi enable`), never disable it.
    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      capability: "full",
      appliedProfile: "none",
      verified: true,
    });
    const commands = client.getAllCommands();
    expect(commands).toContain("shell svc wifi enable");
    expect(commands).not.toContain("shell svc wifi disable");
  });

  test("honors explicit numeric overrides over the profile's named specs", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({
      networkCondition: { profile: "3g", delayMs: 250, downloadKbps: 1000, uploadKbps: 400 },
    });

    expect(result.success).toBe(true);
    expect(result.networkCondition?.capability).toBe("partial");
    expect(result.networkCondition?.values).toMatchObject({
      delayMs: 250,
      downloadKbps: 1000,
      uploadKbps: 400,
    });
    expect(client.getAllCommands()).toEqual([
      "emu gsm data on",
      "emu network delay 250:250",
      "emu network speed 400:1000",
      "shell svc wifi disable",
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
    expect(result.networkCondition?.verified).toBe(false);
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
    });
    // A read proves console reachability only — it verifies no specific condition,
    // so it must NOT claim verified:true (issue #6012 review).
    expect(result.networkCondition?.verified).toBeUndefined();
    expect(result.networkCondition?.rawStatus).toContain("network status");
    expect(client.getAllCommands()).toEqual(["emu network status"]);
  });

  test("parses a full emulator network status into structured observed values (#6085)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(
      "emu network status",
      [
        "Current network status:",
        "  download speed:   236800 bits/s (231.2 KB/s)",
        "  upload speed:     118400 bits/s (115.6 KB/s)",
        "  minimum latency:  80 ms",
        "  maximum latency:  400 ms",
      ].join("\n"),
    );

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.getState(["networkCondition"]);

    // bits/s -> kbps, delay reflects the MAX latency.
    expect(result.networkCondition?.observedValues).toEqual({
      downloadKbps: 237,
      uploadKbps: 118,
      delayMs: 400,
    });
    // rawStatus is still surfaced verbatim, and the read never claims verified.
    expect(result.networkCondition?.rawStatus).toContain("download speed");
    expect(result.networkCondition?.verified).toBeUndefined();
  });

  test("keeps rawStatus and omits observed values when the status is unparseable (#6085)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("emu network status", "network shaping: unknown legacy format\n");

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.getState(["networkCondition"]);

    expect(result.success).toBe(true);
    expect(result.networkCondition?.rawStatus).toContain("unknown legacy format");
    // No field could be parsed, so no structured values are claimed.
    expect(result.networkCondition?.observedValues).toBeUndefined();
  });

  test("parseEmulatorNetworkStatus extracts partial fields defensively without throwing (#6085)", () => {
    // Only latency present (min, no max): fall back to the minimum latency.
    expect(parseEmulatorNetworkStatus("  minimum latency:  35 ms\n")).toEqual({ delayMs: 35 });
    // Only download speed present, comma-grouped digits tolerated.
    expect(parseEmulatorNetworkStatus("download speed: 1,920,000 bits/s (1875 KB/s)")).toEqual({
      downloadKbps: 1920,
    });
    // Empty / whitespace / non-matching all fall back to null, never throw.
    expect(parseEmulatorNetworkStatus("")).toBeNull();
    expect(parseEmulatorNetworkStatus("   ")).toBeNull();
    expect(parseEmulatorNetworkStatus("OK")).toBeNull();
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

  // Convergence audit (#6012): one classifier is the single source of truth for
  // the schema refinement, the restore-slot decision, and the setter's
  // capability/verified. Pin every input shape here.
  test("classifyNetworkConditionRequest pins every input shape", () => {
    const cases: Array<[SetNetworkConditionInput, string]> = [
      [{}, "empty"],
      [{ cancel: false }, "empty"],
      [{ reset: false }, "empty"],
      [{ expiresInSeconds: 30 }, "empty"],
      [{ cancel: false, expiresInSeconds: 30 }, "empty"],
      [{ cancel: true }, "reset"],
      [{ reset: true }, "reset"],
      [{ cancel: true, delayMs: 500 }, "reset"],
      [{ profile: "none" }, "reset"],
      [{ profile: "3g" }, "degrade"],
      [{ profile: "offline" }, "degrade"],
      [{ delayMs: 400 }, "degrade"],
      [{ downloadKbps: 500 }, "degrade"],
      [{ uploadKbps: 200 }, "degrade"],
      [{ profile: "3g", delayMs: 250 }, "degrade"],
      [{ packetLossPercent: 20 }, "loss-only"],
      [{ packetLossPercent: 20, expiresInSeconds: 5 }, "loss-only"],
      // offline + a shaping override is self-contradictory → invalid.
      [{ profile: "offline", delayMs: 500 }, "invalid"],
      [{ profile: "offline", downloadKbps: 100 }, "invalid"],
      // offline + packetLossPercent is redundant, not contradictory → still a degrade.
      [{ profile: "offline", packetLossPercent: 50 }, "degrade"],
      // cancel:true wins even over an offline+override combo.
      [{ profile: "offline", delayMs: 500, cancel: true }, "reset"],
      // #6090: neutral (zero / documented no-op) overrides do NOT degrade. `none`
      // plus all-neutral overrides is a clean reset, not a Wi-Fi-disabling degrade.
      [{ profile: "none", delayMs: 0 }, "reset"],
      [{ profile: "none", downloadKbps: 0 }, "reset"],
      [{ profile: "none", uploadKbps: 0 }, "reset"],
      [{ profile: "none", packetLossPercent: 0 }, "reset"],
      [
        { profile: "none", delayMs: 0, downloadKbps: 0, uploadKbps: 0, packetLossPercent: 0 },
        "reset",
      ],
      // A bare neutral override with no profile is a no-op, not a request.
      [{ delayMs: 0 }, "empty"],
      [{ downloadKbps: 0 }, "empty"],
      [{ uploadKbps: 0 }, "empty"],
      [{ packetLossPercent: 0 }, "empty"],
      // A non-neutral override over `none` still degrades.
      [{ profile: "none", delayMs: 500 }, "degrade"],
      [{ profile: "none", downloadKbps: 100 }, "degrade"],
      // A neutral delay alongside a real non-neutral override still degrades.
      [{ delayMs: 0, downloadKbps: 100 }, "degrade"],
    ];
    for (const [input, expected] of cases) {
      expect(classifyNetworkConditionRequest(input)).toBe(expected as never);
    }
    // networkConditionInputIsRequest is the schema gate: rejects empty AND invalid.
    expect(networkConditionInputIsRequest({})).toBe(false);
    expect(networkConditionInputIsRequest({ cancel: false })).toBe(false);
    expect(networkConditionInputIsRequest({ expiresInSeconds: 30 })).toBe(false);
    expect(networkConditionInputIsRequest({ profile: "offline", delayMs: 5 })).toBe(false);
    expect(networkConditionInputIsRequest({ cancel: true })).toBe(true);
    expect(networkConditionInputIsRequest({ packetLossPercent: 20 })).toBe(true);
    // networkConditionInputError carries distinct messages for empty vs invalid.
    expect(networkConditionInputError({})).toContain("no change to apply");
    expect(networkConditionInputError({ profile: "offline", delayMs: 5 })).toContain("offline");
    expect(networkConditionInputError({ profile: "3g" })).toBeNull();
  });

  test("rejects offline combined with a shaping override (no unapplied echo)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({
      networkCondition: { profile: "offline", delayMs: 500 },
    });

    expect(result.success).toBe(false);
    expect(result.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      verified: false,
    });
    expect(result.networkCondition?.error).toContain("offline");
    // The unapplied 500ms override is NOT echoed in the reported values.
    expect(result.networkCondition?.values?.delayMs).toBe(0);
    // No console command is issued for a rejected request.
    expect(client.getAllCommands()).toEqual([]);
  });

  test("does not disable Wi-Fi or report partial for a no-op fast profile (5g dropped)", () => {
    // 5g was identical to none and only a confusing no-op; it no longer exists.
    expect(NETWORK_CONDITION_PROFILES).not.toHaveProperty("5g");
  });

  test("omits the emulator-console method on non-applying (empty/loss-only) results", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const deviceState = new DeviceState(androidDevice, { adbFactory });

    const empty = await deviceState.setState({ networkCondition: { cancel: false } });
    const lossOnly = await deviceState.setState({ networkCondition: { packetLossPercent: 20 } });

    // Neither issued a console command, so — like the physical branch — neither
    // claims the emulator-console method (issue #6012 review).
    expect(empty.networkCondition?.method).toBeUndefined();
    expect(lossOnly.networkCondition?.method).toBeUndefined();
  });

  test("reports a packet-loss-only request as unsupported, not verified (no command)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { packetLossPercent: 20 } });

    // The emulator has no loss verb, so this applies nothing — never verified.
    expect(result.success).toBe(false);
    expect(result.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
    });
    expect(result.networkCondition?.verified).not.toBe(true);
    expect(result.networkCondition?.error).toContain("Packet loss");
    // No shaping command was issued for an unenforceable request.
    expect(client.getAllCommands()).toEqual([]);
  });

  test("rejects an empty networkCondition request at the setter (no command)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { cancel: false } });

    expect(result.success).toBe(false);
    expect(result.networkCondition?.verified).not.toBe(true);
    expect(result.networkCondition?.error).toContain("no change to apply");
    expect(client.getAllCommands()).toEqual([]);
  });

  test("rolls back to normal connectivity when a mid-degrade command fails", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    // `network delay` succeeds, then `network speed` fails after the radio + delay
    // were already applied — the device must not be left half-shaped.
    client.setCommandResult("emu network speed umts", "", "KO: bad speed");

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "3g" } });

    expect(result.success).toBe(false);
    expect(result.networkCondition?.error).toContain("KO");
    const commands = client.getAllCommands();
    // The rollback reset sequence runs after the failed command.
    expect(commands).toContain("emu network delay none");
    expect(commands).toContain("emu network speed full");
    expect(commands).toContain("emu gsm data on");
    expect(commands).toContain("shell svc wifi enable");
    // Rollback happens after the failing speed command, not before it.
    expect(commands.indexOf("emu network delay none")).toBeGreaterThan(
      commands.indexOf("emu network speed umts"),
    );
  });

  test("reset that cannot re-enable Wi-Fi is NOT reported verified (restorer keeps retrying)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    // The reset emu commands succeed, but re-enabling Wi-Fi fails.
    client.setCommandResult("shell svc wifi enable", "", "error: wifi service not available");

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { cancel: true } });

    // Connectivity is not fully restored, so success must be false — otherwise the
    // session restorer would stop retrying and leave Wi-Fi off (issue #6012 P1).
    expect(result.success).toBe(false);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "partial",
      appliedProfile: "none",
      verified: false,
    });
    expect(result.networkCondition?.error).toContain("Wi-Fi");
  });

  test("rolls back to normal connectivity when a degrade command THROWS mid-sequence", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    // `network speed` rejects (thrown, not a KO string) after radio + delay applied.
    client.setCommandError("emu network speed umts", new Error("adb: device offline"));

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "3g" } });

    expect(result.success).toBe(false);
    expect(result.networkCondition?.error).toContain("device offline");
    const commands = client.getAllCommands();
    // Rollback runs even though the failure was a throw, not a KO result.
    expect(commands).toContain("emu network delay none");
    expect(commands).toContain("emu network speed full");
    expect(commands).toContain("emu gsm data on");
    expect(commands).toContain("shell svc wifi enable");
  });

  test("networkConditionInputDegrades distinguishes shaping from resets and no-ops", () => {
    // A real profile degrades.
    expect(networkConditionInputDegrades({ profile: "3g" })).toBe(true);
    // A shaping override over the `none` baseline degrades even with no profile,
    // so the session layer records a restore slot (issue #6012 leak guard).
    expect(networkConditionInputDegrades({ delayMs: 500 })).toBe(true);
    expect(networkConditionInputDegrades({ profile: "none", downloadKbps: 100 })).toBe(true);
    // Resets and plain `none` do not.
    expect(networkConditionInputDegrades({ cancel: true })).toBe(false);
    expect(networkConditionInputDegrades({ reset: true, profile: "3g" })).toBe(false);
    expect(networkConditionInputDegrades({ profile: "none" })).toBe(false);
    // Packet loss alone is not appliable by the emulator console, so it is not a
    // degrade for restore purposes.
    expect(networkConditionInputDegrades({ packetLossPercent: 20 })).toBe(false);
  });

  test("applies a shaping override with no profile (override-only degrade, disables Wi-Fi)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { delayMs: 500 } });

    // An override-only request resolves to profile `none` but still degrades, so
    // it must be reported `partial` and DISABLE Wi-Fi (not re-enable it).
    expect(result.success).toBe(true);
    expect(result.networkCondition?.capability).toBe("partial");
    expect(result.networkCondition?.verified).toBeUndefined();
    expect(result.networkCondition?.values).toMatchObject({ delayMs: 500 });
    expect(client.getAllCommands()).toEqual([
      "emu network delay 500:500",
      "emu network speed 0:0",
      "emu gsm data on",
      "shell svc wifi disable",
    ]);
  });

  test("surfaces a best-effort Wi-Fi toggle failure in the partial warning", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell svc wifi disable", "", "error: wifi service not available");

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.setState({ networkCondition: { profile: "3g" } });

    // The Wi-Fi failure does NOT abort the request; it feeds the partial warning.
    expect(result.success).toBe(true);
    expect(result.networkCondition?.capability).toBe("partial");
    expect(result.networkCondition?.warning).toContain("Wi-Fi toggle");
    expect(client.getAllCommands()).toContain("shell svc wifi disable");
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
