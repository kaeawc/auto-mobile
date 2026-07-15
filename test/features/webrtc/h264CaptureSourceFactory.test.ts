import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  createH264CaptureSource,
  IosH264Source,
} from "../../../src/features/webrtc";

const ANDROID: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "Pixel",
} as BootedDevice;

const IOS: BootedDevice = {
  deviceId: "4DA8AF35-C59B-43D3-A8FE-5640A7B0B8C1",
  platform: "ios",
  name: "iPhone 16",
} as BootedDevice;

describe("createH264CaptureSource", () => {
  test("routes Android devices to the Android source path (null jar → screenrecord)", () => {
    const source = createH264CaptureSource({ device: ANDROID, onData: () => {} }, null);

    expect(source).not.toBeInstanceOf(IosH264Source);
    expect(typeof source.start).toBe("function");
    expect(typeof source.stop).toBe("function");
  });

  test("routes iOS devices to the iOS source path (jar path ignored)", () => {
    const source = createH264CaptureSource({ device: IOS, onData: () => {} }, "/tmp/automobile-video.jar");

    expect(source).toBeInstanceOf(IosH264Source);
  });
});
