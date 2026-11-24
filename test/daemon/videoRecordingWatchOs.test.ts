import { describe, expect, test } from "bun:test";
import { startVideoRecording } from "../../src/daemon/videoRecordingManager";
import { ActionableError } from "../../src/models";

describe("startVideoRecording on a watch (#19056)", () => {
  test("refuses audio before any capture state exists", async () => {
    const start = startVideoRecording({
      device: { name: "Apple Watch", deviceId: "WATCH-UDID", platform: "watchos" },
      audio: true,
    });
    await expect(start).rejects.toBeInstanceOf(ActionableError);
    await expect(start).rejects.toThrow(
      "audio is not supported for Apple Watch recordings; record without audio.",
    );
  });

  test("still refuses a Vision Pro before any capture state exists", async () => {
    const start = startVideoRecording({
      device: { name: "Apple Vision Pro", deviceId: "VISION-UDID", platform: "visionos" },
    });
    await expect(start).rejects.toThrow("Video recording is not supported on visionOS yet");
  });
});
