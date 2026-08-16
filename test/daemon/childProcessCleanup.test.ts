import { describe, expect, test } from "bun:test";
import { cleanupDaemonChildProcesses } from "../../src/daemon/childProcessCleanup";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";

describe("cleanupDaemonChildProcesses", () => {
  test("stops every recording, interrupts failed stops, and still shuts down iOS CtrlProxy", async () => {
    const calls: string[] = [];

    await cleanupDaemonChildProcesses({
      listActiveVideoRecordings: async () => [
        { recordingId: "recording-a" },
        { recordingId: "recording-b" },
      ] as VideoRecordingRecord[],
      stopVideoRecording: async recordingId => {
        calls.push(`stop:${recordingId}`);
        if (recordingId === "recording-a") {
          throw new Error("capture process already exited");
        }
      },
      interruptVideoRecording: async recordingId => {
        calls.push(`interrupt:${recordingId}`);
      },
      shutdownIOSCtrlProxies: async () => {
        calls.push("shutdown-ios-ctrl-proxies");
      },
    });

    expect(calls).toEqual([
      "stop:recording-a",
      "interrupt:recording-a",
      "stop:recording-b",
      "shutdown-ios-ctrl-proxies",
    ]);
  });

  test("continues cleanup when interrupting a recording or stopping CtrlProxy fails", async () => {
    const calls: string[] = [];

    await cleanupDaemonChildProcesses({
      listActiveVideoRecordings: async () => [
        { recordingId: "recording-a" },
        { recordingId: "recording-b" },
      ] as VideoRecordingRecord[],
      stopVideoRecording: async recordingId => {
        calls.push(`stop:${recordingId}`);
        throw new Error("stop failed");
      },
      interruptVideoRecording: async recordingId => {
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
      "stop:recording-a",
      "interrupt:recording-a",
      "stop:recording-b",
      "interrupt:recording-b",
      "shutdown-ios-ctrl-proxies",
    ]);
  });
});
