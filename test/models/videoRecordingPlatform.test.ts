import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import {
  isSimctlVideoPlatform,
  isVideoRecordingPlatform,
  requireVideoRecordingPlatform,
} from "../../src/models/VideoRecordingPlatform";

describe("video recording platforms (#16725, #19056)", () => {
  test("Android, iOS, Apple TV and Apple Watch record; the Apple simulators through simctl", () => {
    for (const platform of ["android", "ios", "tvos", "watchos"] as const) {
      expect(isVideoRecordingPlatform(platform)).toBe(true);
      expect(requireVideoRecordingPlatform(platform, "Video recording")).toBe(platform);
    }
    expect(isSimctlVideoPlatform("ios")).toBe(true);
    expect(isSimctlVideoPlatform("tvos")).toBe(true);
    expect(isSimctlVideoPlatform("watchos")).toBe(true);
    expect(isSimctlVideoPlatform("android")).toBe(false);
  });

  test("a Vision Pro is refused by name", () => {
    expect(isVideoRecordingPlatform("visionos")).toBe(false);
    expect(isSimctlVideoPlatform("visionos")).toBe(false);
    expect(() => requireVideoRecordingPlatform("visionos", "Video recording")).toThrow(
      new ActionableError(
        "Video recording is not supported on visionOS yet. Target an Android, iOS, Apple TV or Apple Watch device instead.",
      ),
    );
    expect(() => requireVideoRecordingPlatform("visionos", "videoRecording stop")).toThrow(
      "videoRecording stop is not supported on visionOS yet",
    );
  });
});
