import { describe, expect, test } from "bun:test";
import { startVideoRecording } from "../../src/daemon/videoRecordingManager";
import { ActionableError } from "../../src/models";

describe("startVideoRecording on a watch (#14899)", () => {
  test("rejects before any capture state exists", async () => {
    const start = startVideoRecording({
      device: { name: "Apple Watch", deviceId: "WATCH-UDID", platform: "watchos" },
    });
    await expect(start).rejects.toBeInstanceOf(ActionableError);
    await expect(start).rejects.toThrow("Video recording is not supported on watchOS yet");
  });
});
