import { describe, expect, test } from "bun:test";
import {
  NO_ACTIVE_VIDEO_RECORDING,
  describeNoActiveVideoRecording,
} from "../../src/server/videoStopNoActiveRecording";

describe("describeNoActiveVideoRecording (#19194)", () => {
  test("keeps the plain refusal when the device has no finished recording", () => {
    expect(describeNoActiveVideoRecording(undefined)).toBe(NO_ACTIVE_VIDEO_RECORDING);
  });

  test("names the auto-stopped recording, its file and archive resource", () => {
    const message = describeNoActiveVideoRecording({
      recordingId: "rec-1",
      filePath: "/archive/rec-1.mp4",
      endedAt: "2026-11-24T10:00:00.000Z",
    });
    expect(message).toBe(
      `${NO_ACTIVE_VIDEO_RECORDING} The most recent recording on this device, rec-1, already ` +
        "ended at 2026-11-24T10:00:00.000Z (a recording stops on its own when its maxDuration " +
        "elapses). Its file is /archive/rec-1.mp4; read it from automobile:video/archive/rec-1.",
    );
  });
});
