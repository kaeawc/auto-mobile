import { opaqueIntentKey } from "../../src/daemon/sessionBroker/mutations/types";
import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { AppearanceMutationPriorReader } from "../../src/server/deviceMutationAppearancePriorReader";

const ANDROID: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
const IOS: BootedDevice = { deviceId: "sim", platform: "ios", name: "Sim" };
const STATUS_BAR = { kind: "status-bar", key: "device" };

describe("Appearance journal intents (#14359)", () => {
  test("statusBar override journals the device override; clear and get change nothing", () => {
    expect(
      deviceToolMutations("statusBar", { action: "override", time: "9:41" }, "android"),
    ).toEqual([STATUS_BAR]);
    expect(deviceToolMutations("statusBar", { action: "override", time: "9:41" }, "ios")).toEqual([
      STATUS_BAR,
    ]);
    expect(deviceToolMutations("statusBar", { action: "clear" }, "android")).toEqual([]);
    expect(deviceToolMutations("statusBar", { action: "get" }, "ios")).toEqual([]);
  });

  test.each(["samsung-oneui", undefined, "unknown", "toString"])(
    "manufacturerProfile apply %s records a fallback for unproven kill/display restoration",
    (manufacturerProfile) => {
      expect(
        deviceToolMutations(
          "manufacturerProfile",
          { action: "apply", manufacturerProfile },
          "android",
        ),
      ).toEqual([
        { kind: "keyboard", key: "profile" },
        { kind: "opaque", key: opaqueIntentKey("manufacturerProfile", "apply") },
      ]);
    },
  );

  test("keyboard-only manufacturerProfile records only its keyboard row", () => {
    expect(
      deviceToolMutations(
        "manufacturerProfile",
        { action: "apply", manufacturerProfile: "pixel-baseline" },
        "android",
      ),
    ).toEqual([{ kind: "keyboard", key: "profile" }]);
  });

  test.each(["list", "describe", "reset"])("manufacturerProfile %s changes nothing", (action) => {
    expect(deviceToolMutations("manufacturerProfile", { action }, "android")).toEqual([]);
  });

  test("manufacturerProfile apply on iOS changes nothing", () => {
    expect(deviceToolMutations("manufacturerProfile", { action: "apply" }, "ios")).toEqual([]);
  });

  test("the Android prior is the sysui_demo_allowed value read before demo mode is enabled", async () => {
    const reader = (value: string | null) =>
      new AppearanceMutationPriorReader(() => ({ readDemoAllowed: async () => value }));
    expect(await reader("1").read(ANDROID, [STATUS_BAR])).toEqual([
      { state: "present", value: "1" },
    ]);
    expect(await reader(null).read(ANDROID, [STATUS_BAR])).toEqual([{ state: "absent" }]);
  });

  test("an unreadable Android prior is unobservable, never invented", async () => {
    const reader = new AppearanceMutationPriorReader(() => ({
      readDemoAllowed: async () => {
        throw new Error("adb offline");
      },
    }));
    expect(await reader.read(ANDROID, [STATUS_BAR])).toEqual([{ state: "unobservable" }]);
  });

  test("an iOS Simulator session starts without a status-bar override because every reset clears it", async () => {
    const reader = new AppearanceMutationPriorReader(() => {
      throw new Error("iOS must not read demo mode");
    });
    expect(await reader.read(IOS, [STATUS_BAR])).toEqual([{ state: "absent" }]);
  });

  test("intents the family does not own stay unobservable", async () => {
    const reader = new AppearanceMutationPriorReader(() => ({ readDemoAllowed: async () => "1" }));
    expect(await reader.read(ANDROID, [{ kind: "keyboard", key: "profile" }])).toEqual([
      { state: "unobservable" },
    ]);
  });
});
