import { describe, expect, test } from "bun:test";
import { cleanupDaemonChildProcesses } from "../../src/daemon/childProcessCleanup";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";
import { FakeTimer } from "../fakes/FakeTimer";

describe("cleanupDaemonChildProcesses", () => {
  test("stops every recording, interrupts failed stops, and still shuts down iOS CtrlProxy", async () => {
    const calls: string[] = [];

    await cleanupDaemonChildProcesses({
      stopAcceptingVideoRecordingStarts: async () => {
        calls.push("stop-recording-starts");
      },
      listActiveVideoRecordings: async () =>
        [{ recordingId: "recording-a" }, { recordingId: "recording-b" }] as VideoRecordingRecord[],
      listOwnedActiveVideoRecordingIds: () => [],
      stopVideoRecording: async (recordingId) => {
        calls.push(`stop:${recordingId}`);
        if (recordingId === "recording-a") {
          throw new Error("capture process already exited");
        }
      },
      forceStopVideoRecording: async (recordingId) => {
        calls.push(`force-stop:${recordingId}`);
      },
      interruptVideoRecording: async (recordingId) => {
        calls.push(`interrupt:${recordingId}`);
      },
      shutdownIOSCtrlProxies: async () => {
        calls.push("shutdown-ios-ctrl-proxies");
      },
    });

    expect(calls).toEqual([
      "stop-recording-starts",
      "shutdown-ios-ctrl-proxies",
      "stop:recording-a",
      "stop:recording-b",
      "force-stop:recording-a",
      "interrupt:recording-a",
    ]);
  });

  test("continues cleanup when interrupting a recording or stopping CtrlProxy fails", async () => {
    const calls: string[] = [];

    await cleanupDaemonChildProcesses({
      stopAcceptingVideoRecordingStarts: async () => {
        calls.push("stop-recording-starts");
      },
      listActiveVideoRecordings: async () =>
        [{ recordingId: "recording-a" }, { recordingId: "recording-b" }] as VideoRecordingRecord[],
      listOwnedActiveVideoRecordingIds: () => [],
      stopVideoRecording: async (recordingId) => {
        calls.push(`stop:${recordingId}`);
        throw new Error("stop failed");
      },
      forceStopVideoRecording: async (recordingId) => {
        calls.push(`force-stop:${recordingId}`);
      },
      interruptVideoRecording: async (recordingId) => {
        calls.push(`interrupt:${recordingId}`);
        if (recordingId === "recording-a") {
          throw new Error("interrupt failed");
        }
      },
      shutdownIOSCtrlProxies: async () => {
        calls.push("shutdown-ios-ctrl-proxies");
        throw new Error("iproxy cleanup failed");
      },
    });

    expect(calls).toEqual([
      "stop-recording-starts",
      "shutdown-ios-ctrl-proxies",
      "stop:recording-a",
      "stop:recording-b",
      "force-stop:recording-a",
      "force-stop:recording-b",
      "interrupt:recording-a",
      "interrupt:recording-b",
    ]);
  });

  test("waits for a timed stop before marking a recording interrupted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const calls: string[] = [];
    let rejectStop: ((error: Error) => void) | undefined;
    const cleanup = cleanupDaemonChildProcesses({
      stopAcceptingVideoRecordingStarts: async () => {
        calls.push("stop-recording-starts");
      },
      listActiveVideoRecordings: async () =>
        [
          { recordingId: "hung-recording" },
          { recordingId: "later-recording" },
        ] as VideoRecordingRecord[],
      listOwnedActiveVideoRecordingIds: () => [],
      stopVideoRecording: async (recordingId) => {
        calls.push(`stop:${recordingId}`);
        if (recordingId === "hung-recording") {
          await new Promise<void>((_resolve, reject) => {
            rejectStop = reject;
          });
        }
      },
      forceStopVideoRecording: async (recordingId) => {
        calls.push(`force-stop:${recordingId}`);
      },
      interruptVideoRecording: async (recordingId) => {
        calls.push(`interrupt:${recordingId}`);
      },
      shutdownIOSCtrlProxies: async () => {
        calls.push("shutdown-ios-ctrl-proxies");
      },
      timer,
      timeoutMs: 10,
    });

    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    timer.advanceTime(10);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([
      "stop-recording-starts",
      "shutdown-ios-ctrl-proxies",
      "stop:hung-recording",
      "stop:later-recording",
      "force-stop:hung-recording",
    ]);

    rejectStop?.(new Error("force-stop cancelled finalization"));
    await cleanup;

    expect(calls).toEqual([
      "stop-recording-starts",
      "shutdown-ios-ctrl-proxies",
      "stop:hung-recording",
      "stop:later-recording",
      "force-stop:hung-recording",
      "interrupt:hung-recording",
    ]);
  });

  test("uses owned captures when the recording repository is unavailable", async () => {
    const calls: string[] = [];

    await cleanupDaemonChildProcesses({
      stopAcceptingVideoRecordingStarts: async () => {},
      listActiveVideoRecordings: async () => {
        throw new Error("database closed");
      },
      listOwnedActiveVideoRecordingIds: () => ["in-memory-recording"],
      stopVideoRecording: async (recordingId) => {
        calls.push(`stop:${recordingId}`);
      },
      forceStopVideoRecording: async (recordingId) => {
        calls.push(`force:${recordingId}`);
      },
      interruptVideoRecording: async (recordingId) => {
        calls.push(`interrupt:${recordingId}`);
      },
      shutdownIOSCtrlProxies: async () => {},
    });

    expect(calls).toEqual(["stop:in-memory-recording"]);
  });
});
