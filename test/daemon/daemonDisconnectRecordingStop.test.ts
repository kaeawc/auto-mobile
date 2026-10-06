import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import * as videoRecordingManager from "../../src/server/videoRecordingManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

// Issue #10217: an unattended stop of an iOS recording started with `resolution` can hold
// ffmpeg for minutes. Device-disconnect cleanup must not hold the device release that long.
const DISCONNECT_STOP_WAIT_MS = 60_000;

interface DisconnectRecordingStopSurface {
  stoppingRecordings: Set<string>;
  stopRecordingAfterDeviceDisconnect(recordingId: string, deviceId: string): Promise<boolean>;
}

function disconnectRecordingStopHarness(timer: FakeTimer): DisconnectRecordingStopSurface {
  const daemon: Daemon = Object.create(Daemon.prototype);
  return Object.assign(daemon, {
    timer,
    stoppingRecordings: new Set<string>(),
  }) as unknown as DisconnectRecordingStopSurface;
}

describe("recording stop after a device disconnect (#10217)", () => {
  const stop = spyOn(videoRecordingManager, "stopVideoRecordingUnattended");

  afterEach(() => {
    stop.mockReset();
  });

  test("returns once a quick stop finishes", async () => {
    const daemon = disconnectRecordingStopHarness(new FakeTimer());
    stop.mockResolvedValue({} as Awaited<ReturnType<typeof stop>>);

    expect(await daemon.stopRecordingAfterDeviceDisconnect("rec-1", "device-1")).toBe(true);

    expect(stop).toHaveBeenCalledWith("rec-1");
    expect(daemon.stoppingRecordings.has("rec-1")).toBe(false);
  });

  test("releases the device at the wait bound while a long post-process keeps running", async () => {
    const timer = new FakeTimer();
    const daemon = disconnectRecordingStopHarness(timer);
    let finishStop: (() => void) | undefined;
    stop.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStop = () => resolve({} as Awaited<ReturnType<typeof stop>>);
        }),
    );

    let released = false;
    const cleanup = daemon
      .stopRecordingAfterDeviceDisconnect("rec-2", "device-2")
      .then((result) => {
        released = true;
        return result;
      });
    timer.advanceTime(DISCONNECT_STOP_WAIT_MS - 1);
    await drainMicrotasks(20);
    expect(released).toBe(false);

    timer.advanceTime(1);
    expect(await cleanup).toBe(true);

    // Still finishing in the background: tracked, so no second stop is started for it.
    expect(daemon.stoppingRecordings.has("rec-2")).toBe(true);
    expect(await daemon.stopRecordingAfterDeviceDisconnect("rec-2", "device-2")).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);

    finishStop?.();
    await drainUntil(() => !daemon.stoppingRecordings.has("rec-2"), {
      description: "the background stop to finish",
    });
  });
});
