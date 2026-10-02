import { afterEach, describe, expect, test } from "bun:test";
import { createVideoRecordingDeviceIncarnationListener } from "../../src/server/videoRecordingIncarnationListener";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";
import { resetVideoRecordingManagerDependencies } from "../../src/server/videoRecordingManager";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";

describe("video recording incarnation listener", () => {
  afterEach(() => resetVideoRecordingManagerDependencies());
  test("retries failed retirement after load while preparing the other recordings", async () => {
    const calls: string[] = [];
    const failure = new Error("device temp-file cleanup failed");
    const listener = createVideoRecordingDeviceIncarnationListener(
      {
        listActiveVideoRecordings: async () =>
          [{ recordingId: "one" }, { recordingId: "two" }] as VideoRecordingRecord[],
        forceStopVideoRecording: async (id) => {
          calls.push(`force:${id}`);
          if (id === "one") {
            throw failure;
          }
        },
        interruptVideoRecording: async (id) => {
          calls.push(`interrupt:${id}`);
        },
      },
      { timer: new FakeTimer() },
    );

    await expect(listener.prepareForIncarnationChange?.("emulator-5554")).rejects.toBe(failure);
    expect(calls).toEqual(["force:one", "force:two", "interrupt:two"]);
    await listener.onDeviceIncarnationChanged("emulator-5556");
    expect(calls).toHaveLength(3);
    await listener.onDeviceIncarnationChanged("emulator-5554");
    expect(calls).toEqual(["force:one", "force:two", "interrupt:two", "interrupt:one"]);
    await listener.onDeviceIncarnationChanged("emulator-5554");
    expect(calls).toHaveLength(4);
  });
  test("retires a force-stop failure in the post-load phase", async () => {
    const interrupted: string[] = [];
    const listener = createVideoRecordingDeviceIncarnationListener(
      {
        listActiveVideoRecordings: async () => [{ recordingId: "one" }] as VideoRecordingRecord[],
        forceStopVideoRecording: async () => {
          throw new Error("cleanup failed");
        },
        interruptVideoRecording: async (id) => {
          interrupted.push(id);
        },
      },
      { timer: new FakeTimer() },
    );
    await expect(listener.prepareForIncarnationChange?.("emulator-5554")).rejects.toThrow(
      "cleanup failed",
    );
    await listener.onDeviceIncarnationChanged("emulator-5554");
    expect(interrupted).toEqual(["one"]);
  });

  test("retries an interrupt failure after load", async () => {
    let attempts = 0;
    const failure = new Error("row retirement failed");
    const listener = createVideoRecordingDeviceIncarnationListener(
      {
        listActiveVideoRecordings: async () => [{ recordingId: "one" }] as VideoRecordingRecord[],
        forceStopVideoRecording: async () => {},
        interruptVideoRecording: async () => {
          attempts++;
          if (attempts === 1) {
            throw failure;
          }
        },
      },
      { timer: new FakeTimer() },
    );
    await expect(listener.prepareForIncarnationChange?.("emulator-5554")).rejects.toBe(failure);
    await listener.onDeviceIncarnationChanged("emulator-5554");
    expect(attempts).toBe(2);
    await listener.onDeviceIncarnationChanged("emulator-5554");
    expect(attempts).toBe(2);
  });

  test("attempts every post-load retirement and clears tracking even when one rejects", async () => {
    const calls: string[] = [];
    const listener = createVideoRecordingDeviceIncarnationListener(
      {
        listActiveVideoRecordings: async () =>
          [{ recordingId: "one" }, { recordingId: "two" }] as VideoRecordingRecord[],
        forceStopVideoRecording: async () => {
          throw new Error("force failed");
        },
        interruptVideoRecording: async (id) => {
          calls.push(id);
          if (id === "one") {
            throw new Error("interrupt failed");
          }
        },
      },
      { timer: new FakeTimer() },
    );
    await expect(listener.prepareForIncarnationChange?.("emulator-5554")).rejects.toThrow(
      "force failed",
    );
    await expect(listener.onDeviceIncarnationChanged("emulator-5554")).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(calls).toEqual(["one", "two"]);
    await listener.onDeviceIncarnationChanged("emulator-5554");
    expect(calls).toEqual(["one", "two"]);
  });

  test("force-stops every current-incarnation capture before marking it interrupted", async () => {
    const calls: string[] = [];
    const listener = createVideoRecordingDeviceIncarnationListener(
      {
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
      },
      { timer: new FakeTimer() },
    );

    await listener.prepareForIncarnationChange?.("emulator-5554");
    await listener.onDeviceIncarnationChanged("emulator-5554");

    expect(calls).toEqual([
      "list:emulator-5554",
      "force:one",
      "interrupt:one",
      "force:two",
      "interrupt:two",
    ]);
  });
});
