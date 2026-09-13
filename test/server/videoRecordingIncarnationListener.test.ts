import { describe, expect, test } from "bun:test";
import { createVideoRecordingDeviceIncarnationListener } from "../../src/server/videoRecordingIncarnationListener";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";

describe("video recording incarnation listener", () => {
  test("force-stops every current-incarnation capture before marking it interrupted", async () => {
    const calls: string[] = [];
    const listener = createVideoRecordingDeviceIncarnationListener({
      listActiveVideoRecordings: async ({ deviceId }) => {
        calls.push(`list:${deviceId}`);
        return [{ recordingId: "one" }, { recordingId: "two" }] as VideoRecordingRecord[];
      },
      forceStopVideoRecording: async (recordingId) => {
        calls.push(`force:${recordingId}`);
      },
      interruptVideoRecording: async (recordingId) => {
        calls.push(`interrupt:${recordingId}`);
      },
    });

    await listener.prepareForIncarnationChange?.("emulator-5554");

    expect(calls).toEqual([
      "list:emulator-5554",
      "force:one",
      "interrupt:one",
      "force:two",
      "interrupt:two",
    ]);
  });
});
