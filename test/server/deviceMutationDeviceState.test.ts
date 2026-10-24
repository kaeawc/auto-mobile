import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { DeviceStateMutationPriorReader } from "../../src/server/deviceMutationDeviceStatePriorReader";
import { DefaultMutationPriorReader } from "../../src/server/deviceMutationPriorReader";
import { setDeviceStateSchema } from "../../src/server/utilityTools";
import { addDeviceTargetingToSchema } from "../../src/utils/schemaHelpers";
import { AdbPowerClient } from "../../src/features/utility/power/AndroidPowerClient";
import {
  opaqueForcesFallback,
  opaqueIntentKey,
} from "../../src/daemon/sessionBroker/mutations/types";
import { createExecResult } from "../../src/utils/execResult";
import { FakePowerAdb } from "../fakes/FakePowerAdb";

const ANDROID: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const IOS: BootedDevice = { name: "sim", platform: "ios", deviceId: "SIM-1" };

const keysOf = (entries: readonly { kind: string; key: string }[]) =>
  entries.map((entry) => `${entry.kind}:${entry.key}`);

describe("setDeviceState journal intents", () => {
  test("every advertised state field records a specific intent, not the generic tool breadcrumb", () => {
    const routing = new Set(Object.keys(addDeviceTargetingToSchema(z.object({})).shape));
    const samples: Record<string, unknown> = {
      doNotDisturb: { mode: "none" },
      biometrics: { enrollment: "enrolled" },
      connectivity: { airplaneMode: true },
      networkCondition: { profile: "3g" },
      location: { mode: "static", latitude: 1, longitude: 2 },
      clock: { mode: "reset" },
      cameraPoster: { mode: "qr", text: "hello" },
      screenLock: { type: "pin", credential: "1234" },
      power: { batterySaver: true },
      deviceCondition: { faults: { thermal: "critical" } },
    };
    const fields = Object.keys(setDeviceStateSchema.shape).filter((key) => !routing.has(key));
    expect(fields.toSorted()).toEqual(Object.keys(samples).toSorted());
    for (const field of fields) {
      const entries = deviceToolMutations("setDeviceState", { [field]: samples[field] }, "android");
      expect(entries.length).toBeGreaterThan(0);
      expect(keysOf(entries)).not.toContain("opaque:tool:setDeviceState");
    }
  });

  test("power records one intent per control it changes", () => {
    const entries = deviceToolMutations(
      "setDeviceState",
      {
        power: {
          battery: { level: 10 },
          batterySaver: true,
          dataSaver: false,
          thermalStatus: 3,
          standbyBucket: { appId: "com.example.app", bucket: "rare" },
          appInactive: { appId: "com.example.app", inactive: true },
        },
      },
      "android",
    );
    expect(keysOf(entries)).toEqual([
      "device-setting:power:battery",
      "device-setting:power:batterySaver",
      "device-setting:power:dataSaver",
      "device-setting:power:thermal",
      "device-setting:power:standby:com.example.app",
      "device-setting:power:inactive:com.example.app",
    ]);
  });

  test("forcing Doze also journals the battery it unplugs, unless the caller unplugged it", () => {
    expect(
      keysOf(deviceToolMutations("setDeviceState", { power: { doze: "deep" } }, "android")),
    ).toEqual(["device-setting:power:battery", "device-setting:power:doze"]);
    expect(
      keysOf(
        deviceToolMutations(
          "setDeviceState",
          { power: { doze: "light", battery: { charging: "none" } } },
          "android",
        ),
      ),
    ).toEqual(["device-setting:power:battery", "device-setting:power:doze"]);
    expect(
      keysOf(deviceToolMutations("setDeviceState", { power: { doze: "off" } }, "android")),
    ).toEqual(["device-setting:power:doze"]);
  });

  test("an unrecognizable power object still journals one breadcrumb", () => {
    expect(keysOf(deviceToolMutations("setDeviceState", { power: {} }, "android"))).toEqual([
      "device-setting:power",
    ]);
  });

  test("deviceCondition power faults share the power controls' keys; unset applies nothing", () => {
    expect(
      keysOf(
        deviceToolMutations(
          "setDeviceState",
          {
            deviceCondition: {
              faults: { battery: "low", lowPower: "on", doze: "on", thermal: "throttling" },
            },
          },
          "android",
        ),
      ),
    ).toEqual([
      "device-setting:power:battery",
      "device-setting:power:doze",
      "device-setting:power:batterySaver",
      "device-setting:power:thermal",
    ]);
    // Clearing a fault restores what an earlier call journaled; it records no new intent.
    expect(
      deviceToolMutations(
        "setDeviceState",
        { deviceCondition: { faults: { battery: "unset" }, reset: true } },
        "android",
      ),
    ).toEqual([{ kind: "opaque", key: "tool:setDeviceState" }]);
  });

  test("Android effects nothing reverts force keep-booted reset to escalate", () => {
    const entries = deviceToolMutations(
      "setDeviceState",
      {
        location: { mode: "route" },
        screenLock: { type: "pattern", credential: "1235" },
        cameraPoster: { mode: "image", path: "/tmp/poster.png" },
      },
      "android",
    );
    const fallbacks = entries.filter(opaqueForcesFallback);
    expect(fallbacks.map((entry) => JSON.parse(entry.key.slice("fallback:".length)))).toEqual([
      ["setDeviceState", "location"],
      ["setDeviceState", "screenLock"],
      ["setDeviceState", "cameraPoster"],
    ]);
  });

  test("a deviceCondition package-data clear records the destructive-app intent for that app", () => {
    const clear = {
      deviceCondition: { faults: { clearPackageData: { package: "com.example.app" } } },
    };
    const android = deviceToolMutations("setDeviceState", clear, "android");
    expect(android).toContainEqual({
      kind: "opaque",
      key: opaqueIntentKey("clearAppData", "com.example.app"),
    });
    expect(
      deviceToolMutations("setDeviceState", clear, "ios").filter(opaqueForcesFallback),
    ).toEqual([]);
    const unset = { deviceCondition: { faults: { clearPackageData: "unset" } } };
    expect(
      deviceToolMutations("setDeviceState", unset, "android").filter(opaqueForcesFallback),
    ).toEqual([]);
  });

  test("calls that apply no new Android state add no fallback", () => {
    const entries = deviceToolMutations(
      "setDeviceState",
      {
        location: { mode: "stop" },
        screenLock: { type: "none", currentCredential: "1234" },
        cameraPoster: { mode: "clear" },
      },
      "android",
    );
    expect(entries.filter(opaqueForcesFallback)).toEqual([]);
  });

  test("iOS never records an Android-only fallback", () => {
    const entries = deviceToolMutations(
      "setDeviceState",
      {
        location: { mode: "static", latitude: 1, longitude: 2 },
        screenLock: { type: "pin", credential: "1234" },
      },
      "ios",
    );
    expect(entries.filter(opaqueForcesFallback)).toEqual([]);
    expect(keysOf(entries)).toContain("location:device");
  });
});

function reader(adb: FakePowerAdb): DeviceStateMutationPriorReader {
  return new DeviceStateMutationPriorReader(() => new AdbPowerClient(adb));
}

const setting = (key: string) => ({ kind: "device-setting", key });

describe("setPosture and changeLocalization journal intents", () => {
  test("an Android emulator posture change forces keep-booted reset to escalate", () => {
    const entries = deviceToolMutations("setPosture", { posture: "closed" }, "android");
    expect(entries[0]).toEqual({ kind: "device-setting", key: "tool:setPosture" });
    expect(entries.filter(opaqueForcesFallback)).toHaveLength(1);
    expect(
      deviceToolMutations("setPosture", { hingeAngle: 90 }, "ios").filter(opaqueForcesFallback),
    ).toEqual([]);
  });

  test("the time zone is the clock family's timezone, which the reset ports restore", () => {
    expect(
      deviceToolMutations(
        "changeLocalization",
        { timeZone: "Asia/Tokyo", textDirection: "rtl", timeFormat: "24h" },
        "android",
      ),
    ).toEqual([
      { kind: "clock", key: "timezone" },
      { kind: "device-setting", key: "textDirection" },
      { kind: "device-setting", key: "timeFormat" },
    ]);
  });
});

describe("DeviceStateMutationPriorReader", () => {
  test("the Android time zone prior is persist.sys.timezone, not the device clock state", async () => {
    const adb = new FakePowerAdb();
    adb.setCommandResponse(
      "shell getprop persist.sys.timezone",
      createExecResult("Europe/Paris\n", ""),
    );
    const defaultReader = new DefaultMutationPriorReader(
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error("the clock state must not be read for a time zone row");
      },
      undefined,
      {
        dataReader: {
          read: async (_device, mutations) => mutations.map(() => ({ state: "unobservable" })),
        },
        deviceStateReader: new DeviceStateMutationPriorReader(() => new AdbPowerClient(adb), {
          create: () => adb,
        }),
      },
    );
    expect(await defaultReader.read(ANDROID, [{ kind: "clock", key: "timezone" }])).toEqual([
      { state: "present", value: "Europe/Paris" },
    ]);
  });

  test("an unset or unreadable time zone is unobservable", async () => {
    const adb = new FakePowerAdb();
    adb.setCommandResponse("shell getprop persist.sys.timezone", createExecResult("\n", ""));
    const timeZone = new DeviceStateMutationPriorReader(() => new AdbPowerClient(adb), {
      create: () => adb,
    });
    expect(await timeZone.read(ANDROID, [{ kind: "clock", key: "timezone" }])).toEqual([
      { state: "unobservable" },
    ]);
    expect(await timeZone.read(IOS, [{ kind: "clock", key: "timezone" }])).toEqual([
      { state: "unobservable" },
    ]);
  });

  test("reads each power control with the primitive the control writes", async () => {
    const adb = new FakePowerAdb();
    adb.lowPower = "1";
    adb.restrictBackground = true;
    adb.thermal = { override: true, status: 3 };
    adb.buckets.set("com.example.app", 40);
    adb.inactive.set("com.example.app", true);
    const priors = await reader(adb).read(ANDROID, [
      setting("power:battery"),
      setting("power:doze"),
      setting("power:batterySaver"),
      setting("power:dataSaver"),
      setting("power:thermal"),
      setting("power:standby:com.example.app"),
      setting("power:inactive:com.example.app"),
    ]);
    expect(priors).toEqual([
      { state: "present", value: { level: 100, charging: "ac", status: "charging", faked: false } },
      { state: "present", value: "off" },
      { state: "present", value: true },
      { state: "present", value: true },
      { state: "present", value: { status: 3, override: true } },
      { state: "present", value: "rare" },
      { state: "present", value: true },
    ]);
  });

  test("an unset battery saver setting is an absent prior", async () => {
    const adb = new FakePowerAdb();
    adb.lowPower = "null";
    expect(await reader(adb).read(ANDROID, [setting("power:batterySaver")])).toEqual([
      { state: "absent" },
    ]);
  });

  test("a failed read, an unsettable bucket and a foreign intent are unobservable", async () => {
    const adb = new FakePowerAdb();
    adb.failing.add("dumpsys battery");
    adb.buckets.set("com.example.app", 99);
    const priors = await reader(adb).read(ANDROID, [
      setting("power:battery"),
      setting("power:standby:com.example.app"),
      setting("airplaneMode"),
      { kind: "clock", key: "device" },
    ]);
    // dumpsys battery failing has no level line, so the parser refuses it.
    expect(priors.map((prior) => prior.state)).toEqual([
      "unobservable",
      "unobservable",
      "unobservable",
      "unobservable",
    ]);
  });

  test("iOS has no power controls to read", async () => {
    const adb = new FakePowerAdb();
    const priors = await reader(adb).read(IOS, [setting("power:battery")]);
    expect(priors).toEqual([{ state: "unobservable" }]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a cancelled request is not recorded as an unobservable prior", async () => {
    const controller = new AbortController();
    const adb = new FakePowerAdb();
    controller.abort();
    await expect(
      reader(adb).read(ANDROID, [setting("power:battery")], controller.signal),
    ).rejects.toThrow();
  });

  test("the default reader routes power intents to it and keeps the other priors", async () => {
    const adb = new FakePowerAdb();
    const defaultReader = new DefaultMutationPriorReader(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        dataReader: {
          read: async (_device, mutations) => mutations.map(() => ({ state: "unobservable" })),
        },
        deviceStateReader: reader(adb),
      },
    );
    const priors = await defaultReader.read(ANDROID, [setting("power:dataSaver")]);
    expect(priors).toEqual([{ state: "present", value: false }]);
  });
});
