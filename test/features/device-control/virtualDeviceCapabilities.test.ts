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
        {
          id: "android.emulator.cameraPoster",
          state: "available",
          source: "platform",
        },
        { id: "android.hardware.camera", state: "available", source: "avd_config" },
        { id: "android.hardware.camera.front", state: "available", source: "avd_config" },
        { id: "android.hardware.fingerprint", state: "available", source: "avd_config" },
        { id: "android.hardware.location.gps", state: "available", source: "avd_config" },
        { id: "android.hardware.nfc", state: "unavailable", source: "avd_config" },
      ],
    });
  });

  test("reports poster control independently of unrecognized AVD hardware features", () => {
    expect(
      buildAndroidAvdCapabilityInventory({
        "hw.camera.back": "webcam999",
        "hw.fingerprint": "disabled",
        "hw.gps": "corrupted",
        "hw.ramSize": "2048",
      }),
    ).toEqual({
      schemaVersion: 1,
      capabilities: [
        {
          id: "android.emulator.cameraPoster",
          state: "available",
          source: "platform",
        },
      ],
    });
  });

  test("reports supported and unsupported iOS Simulator capabilities with stable identifiers", () => {
    expect(iosSimulatorCapabilityInventory()).toEqual({
      schemaVersion: 1,
      capabilities: [
        { id: "ios.simulator.biometric", state: "available", source: "platform" },
        {
          id: "ios.simulator.cameraPoster",
          state: "unsupported",
          source: "platform",
          reason: "Camera posters are only supported at Android emulator boot.",
        },
        {
          id: "ios.simulator.nfc",
          state: "unsupported",
          source: "platform",
          reason: "iOS Simulator cannot emulate NFC hardware.",
        },
        {
          id: "ios.simulator.doNotDisturb",
          state: "unsupported",
          source: "platform",
          reason: "Do Not Disturb cannot be read or set on an iOS simulator.",
        },
        {
          id: "ios.simulator.networkCondition",
          state: "available",
          source: "platform",
          reason:
            "Per-app only: setDeviceState networkCondition offline or none with appId, within a session, through the opt-in network-extension backend (install and approval required; getDeviceState networkCondition reports its state). Device-wide conditions and latency or bandwidth profiles are unsupported.",
        },
        {
          id: "ios.simulator.connectivity",
          state: "unsupported",
          source: "platform",
          reason: "iOS Simulator shares the host network stack and has no connectivity read verb.",
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
          id: "ios.simulator.cameraPoster",
          state: "unsupported",
          source: "platform",
          reason: "Camera posters are only supported at Android emulator boot.",
        },
        {
          id: "ios.simulator.nfc",
          state: "unsupported",
          source: "platform",
          reason: "iOS Simulator cannot emulate NFC hardware.",
        },
        {
          id: "ios.simulator.doNotDisturb",
          state: "unsupported",
          source: "platform",
          reason: "Do Not Disturb cannot be read or set on an iOS simulator.",
        },
        {
          id: "ios.simulator.networkCondition",
          state: "available",
          source: "platform",
          reason:
            "Per-app only: setDeviceState networkCondition offline or none with appId, within a session, through the opt-in network-extension backend (install and approval required; getDeviceState networkCondition reports its state). Device-wide conditions and latency or bandwidth profiles are unsupported.",
        },
        {
          id: "ios.simulator.connectivity",
          state: "unsupported",
          source: "platform",
          reason: "iOS Simulator shares the host network stack and has no connectivity read verb.",
        },
      ],
    });
  });
});
