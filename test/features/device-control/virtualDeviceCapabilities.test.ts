import { describe, expect, test } from "bun:test";
import {
  buildAndroidAvdCapabilityInventory,
  iosSimulatorCapabilityInventory,
} from "../../../src/features/device-control/virtualDeviceCapabilities";

describe("virtual device capability inventories", () => {
  test("normalizes configured Android hardware features into stable, deduplicated identifiers", () => {
    expect(
      buildAndroidAvdCapabilityInventory({
        "hw.camera.back": "virtualscene",
        "hw.camera.front": "emulated",
        "hw.fingerprint": "yes",
        "hw.gps": "yes",
        "hw.nfc": "no",
      }),
    ).toEqual({
      schemaVersion: 1,
      capabilities: [
        { id: "android.hardware.camera", state: "available", source: "avd_config" },
        { id: "android.hardware.camera.front", state: "available", source: "avd_config" },
        { id: "android.hardware.fingerprint", state: "available", source: "avd_config" },
        { id: "android.hardware.location.gps", state: "available", source: "avd_config" },
        { id: "android.hardware.nfc", state: "unavailable", source: "avd_config" },
      ],
    });
  });

  test("returns an empty inventory when an AVD exposes no mapped or recognized hardware features", () => {
    expect(
      buildAndroidAvdCapabilityInventory({
        "hw.fingerprint": "disabled",
        "hw.gps": "corrupted",
        "hw.ramSize": "2048",
      }),
    ).toEqual({ schemaVersion: 1, capabilities: [] });
  });

  test("reports supported and unsupported iOS Simulator capabilities with stable identifiers", () => {
    expect(iosSimulatorCapabilityInventory()).toEqual({
      schemaVersion: 1,
      capabilities: [
        { id: "ios.simulator.biometric", state: "available", source: "platform" },
        {
          id: "ios.simulator.nfc",
          state: "unsupported",
          source: "platform",
          reason: "iOS Simulator cannot emulate NFC hardware.",
        },
      ],
    });
  });

  test("marks biometric controls unsupported outside an iOS Simulator runtime", () => {
    expect(
      iosSimulatorCapabilityInventory({
        runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-18-0",
      }),
    ).toEqual({
      schemaVersion: 1,
      capabilities: [
        {
          id: "ios.simulator.biometric",
          state: "unsupported",
          source: "platform",
          reason: "Biometric controls are only supported for iOS Simulator runtimes.",
        },
        {
          id: "ios.simulator.nfc",
          state: "unsupported",
          source: "platform",
          reason: "iOS Simulator cannot emulate NFC hardware.",
        },
      ],
    });
  });
});
