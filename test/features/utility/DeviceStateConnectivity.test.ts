import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  ANDROID_CONNECTIVITY_READ_COMMAND,
  DeviceState,
  DEVICE_STATE_READABLE_FIELDS,
  DEVICE_STATE_WRITABLE_FIELDS,
} from "../../../src/features/utility/DeviceState";
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
  iosVersion: "17.5",
};

/** Device-shaped answer for the batched read, one `<field>=<raw>` line per key. */
const connectivityOutput = (values: {
  airplaneMode?: string;
  wifiEnabled?: string;
  bluetoothEnabled?: string;
  locationEnabled?: string;
}): string =>
  `${[
    `airplaneMode=${values.airplaneMode ?? ""}`,
    `wifiEnabled=${values.wifiEnabled ?? ""}`,
    `bluetoothEnabled=${values.bluetoothEnabled ?? ""}`,
    `locationEnabled=${values.locationEnabled ?? ""}`,
  ].join("\n")}\n`;

describe("DeviceState connectivity toggles (issue #6872)", () => {
  // `secure` settings are per-user; `global` settings are device-wide. Reading
  // `location_mode` unscoped answers user 0 even when the foreground user is a
  // secondary one, so it would contradict the Settings UI the app under test sees.
  test("scopes the per-user secure read to the foreground user", () => {
    expect(ANDROID_CONNECTIVITY_READ_COMMAND).toContain(
      "settings --user current get secure location_mode",
    );
    expect(ANDROID_CONNECTIVITY_READ_COMMAND).toContain("settings get global airplane_mode_on");
    expect(ANDROID_CONNECTIVITY_READ_COMMAND).not.toContain("--user current get global");
  });

  test("reports the foreground user's location state on a secondary user", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    // The device is on user 10, whose location is on; user 0's is off.
    client.setCommandResult(
      ANDROID_CONNECTIVITY_READ_COMMAND,
      connectivityOutput({
        airplaneMode: "0",
        wifiEnabled: "1",
        bluetoothEnabled: "0",
        locationEnabled: "3",
      }),
    );

    const result = await new DeviceState(androidDevice, { adbFactory }).getState(["connectivity"]);

    expect(result.connectivity?.locationEnabled).toBe(true);
    const executed = client.getAllCommands();
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("settings --user current get secure location_mode");
  });

  test("reads airplane/wifi/bluetooth/location in ONE adb invocation", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(
      ANDROID_CONNECTIVITY_READ_COMMAND,
      connectivityOutput({
        airplaneMode: "1",
        wifiEnabled: "0",
        bluetoothEnabled: "1",
        locationEnabled: "3",
      }),
    );

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.getState(["connectivity"]);

    expect(result.success).toBe(true);
    expect(result.connectivity).toMatchObject({
      supported: true,
      method: "android_settings_batch",
      airplaneMode: true,
      wifiEnabled: false,
      bluetoothEnabled: true,
      locationEnabled: true,
    });
    expect(result.connectivity?.error).toBeUndefined();
    expect(result.connectivity?.warning).toBeUndefined();
    // One round-trip, not four.
    expect(client.getAllCommands()).toEqual([ANDROID_CONNECTIVITY_READ_COMMAND]);
  });

  test("is included by default so a bare getDeviceState answers airplane mode", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell settings get global zen_mode", "0\n");
    client.setCommandResult(
      ANDROID_CONNECTIVITY_READ_COMMAND,
      connectivityOutput({
        airplaneMode: "0",
        wifiEnabled: "1",
        bluetoothEnabled: "0",
        locationEnabled: "0",
      }),
    );

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.getState();

    expect(result.success).toBe(true);
    expect(result.doNotDisturb?.enabled).toBe(false);
    expect(result.connectivity?.airplaneMode).toBe(false);
    expect(result.connectivity?.locationEnabled).toBe(false);
  });

  test("reports location_mode 0 as disabled and any non-zero mode as enabled", async () => {
    for (const [raw, expected] of [
      ["0", false],
      ["1", true],
      ["2", true],
      ["3", true],
    ] as const) {
      const adbFactory = new FakeAdbClientFactory();
      adbFactory
        .getFakeClient()
        .setCommandResult(
          ANDROID_CONNECTIVITY_READ_COMMAND,
          connectivityOutput({ airplaneMode: "0", locationEnabled: raw }),
        );
      const result = await new DeviceState(androidDevice, { adbFactory }).getState([
        "connectivity",
      ]);
      expect(result.connectivity?.locationEnabled).toBe(expected);
    }
  });

  test("decodes the airplane-mode wifi_on states (2 enabled override, 3 disabled by airplane)", async () => {
    // AOSP's WifiSettingsStore persists four states in Settings.Global.wifi_on:
    // 0 disabled, 1 enabled, 2 enabled via an airplane-mode override, and
    // 3 disabled BY airplane mode. 2 and 3 are the common states while airplane
    // mode is on, so a strict 0/1 read would blank wifiEnabled exactly then.
    for (const [raw, expected] of [
      ["0", false],
      ["1", true],
      ["2", true],
      ["3", false],
    ] as const) {
      const adbFactory = new FakeAdbClientFactory();
      adbFactory
        .getFakeClient()
        .setCommandResult(
          ANDROID_CONNECTIVITY_READ_COMMAND,
          connectivityOutput({ airplaneMode: "1", wifiEnabled: raw }),
        );

      const result = await new DeviceState(androidDevice, { adbFactory }).getState([
        "connectivity",
      ]);

      expect(result.connectivity?.wifiEnabled).toBe(expected);
      expect(result.connectivity?.warning ?? "").not.toContain("wifiEnabled");
    }
  });

  test("leaves a wifi_on value outside the known states undefined", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory
      .getFakeClient()
      .setCommandResult(
        ANDROID_CONNECTIVITY_READ_COMMAND,
        connectivityOutput({ airplaneMode: "1", wifiEnabled: "4" }),
      );

    const result = await new DeviceState(androidDevice, { adbFactory }).getState(["connectivity"]);

    expect(result.connectivity?.wifiEnabled).toBeUndefined();
    expect(result.connectivity?.warning).toContain("wifiEnabled");
  });

  test("leaves a missing key undefined without failing the sibling reads", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    // `settings get` prints the literal "null" for a key that is not present,
    // and the batched script emits an empty value when the read itself failed.
    client.setCommandResult(
      ANDROID_CONNECTIVITY_READ_COMMAND,
      connectivityOutput({
        airplaneMode: "1",
        wifiEnabled: "null",
        bluetoothEnabled: "",
        locationEnabled: "0",
      }),
    );

    const deviceState = new DeviceState(androidDevice, { adbFactory });
    const result = await deviceState.getState(["connectivity"]);

    expect(result.success).toBe(true);
    expect(result.connectivity?.airplaneMode).toBe(true);
    expect(result.connectivity?.locationEnabled).toBe(false);
    expect(result.connectivity?.wifiEnabled).toBeUndefined();
    expect(result.connectivity?.bluetoothEnabled).toBeUndefined();
    // An absent key is reported, not thrown, and never turns into an error.
    expect(result.connectivity?.error).toBeUndefined();
    expect(result.connectivity?.warning).toContain("wifiEnabled");
    expect(result.connectivity?.warning).toContain("bluetoothEnabled");
    expect(result.connectivity?.rawValues).toMatchObject({ wifiEnabled: "null" });
  });

  test("leaves a malformed value undefined instead of coercing it", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult(
      ANDROID_CONNECTIVITY_READ_COMMAND,
      connectivityOutput({
        airplaneMode: "banana",
        wifiEnabled: "9",
        bluetoothEnabled: "true",
        locationEnabled: "3abc",
      }),
    );

    const result = await new DeviceState(androidDevice, { adbFactory }).getState(["connectivity"]);

    expect(result.connectivity?.airplaneMode).toBeUndefined();
    expect(result.connectivity?.wifiEnabled).toBeUndefined();
    expect(result.connectivity?.bluetoothEnabled).toBeUndefined();
    expect(result.connectivity?.locationEnabled).toBeUndefined();
    expect(result.connectivity?.rawValues).toMatchObject({
      airplaneMode: "banana",
      locationEnabled: "3abc",
    });
    // Nothing at all parsed, so this IS a read failure worth surfacing.
    expect(result.connectivity?.error).toContain("connectivity");
    expect(result.success).toBe(false);
  });

  test("surfaces an adb failure as an error, not a thrown exception", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory
      .getFakeClient()
      .setCommandError(ANDROID_CONNECTIVITY_READ_COMMAND, new Error("device offline"));

    const result = await new DeviceState(androidDevice, { adbFactory }).getState(["connectivity"]);

    expect(result.success).toBe(false);
    expect(result.connectivity?.supported).toBe(true);
    expect(result.connectivity?.error).toContain("device offline");
    expect(result.connectivity?.airplaneMode).toBeUndefined();
  });

  test("reports iOS connectivity as unsupported without issuing a simctl command", async () => {
    const simctl = new FakeSimCtlClient();
    const deviceState = new DeviceState(iosSimulator, { simctl });

    const result = await deviceState.getState(["connectivity"]);

    expect(result.success).toBe(false);
    expect(result.connectivity?.supported).toBe(false);
    expect(result.connectivity?.airplaneMode).toBeUndefined();
    expect(result.connectivity?.error).toContain("Airplane mode");
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });

  test("every setDeviceState-writable field has a getDeviceState-readable counterpart", () => {
    for (const field of DEVICE_STATE_WRITABLE_FIELDS) {
      expect(DEVICE_STATE_READABLE_FIELDS).toContain(field);
    }
  });
});
