import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import {
  isSimctlVideoPlatform,
  isVideoRecordingPlatform,
  requireVideoRecordingPlatform,
} from "../../src/models/VideoRecordingPlatform";

describe("video recording platforms (#16725)", () => {
  test("Android, iOS and Apple TV record; Apple TV through simctl like iOS", () => {
    for (const platform of ["android", "ios", "tvos"] as const) {
      expect(isVideoRecordingPlatform(platform)).toBe(true);
      expect(requireVideoRecordingPlatform(platform, "Video recording")).toBe(platform);
    }
    expect(isSimctlVideoPlatform("ios")).toBe(true);
    expect(isSimctlVideoPlatform("tvos")).toBe(true);
    expect(isSimctlVideoPlatform("android")).toBe(false);
  });

  test("a watch or Vision Pro is refused by name", () => {
    expect(isVideoRecordingPlatform("watchos")).toBe(false);
    expect(isVideoRecordingPlatform("visionos")).toBe(false);
    expect(() => requireVideoRecordingPlatform("watchos", "Video recording")).toThrow(
      new ActionableError(
        "Video recording is not supported on watchOS yet. Target an Android, iOS or Apple TV device instead.",
      ),
    );
    expect(() => requireVideoRecordingPlatform("visionos", "videoRecording stop")).toThrow(
      "videoRecording stop is not supported on visionOS yet",
    );
  });
});
