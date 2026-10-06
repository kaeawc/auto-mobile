import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  buildPidReportingScreenrecordArgs,
  isOwnRecorderCmdline,
  trackDeviceRecorderPid,
} from "../../../src/features/video/androidRecorderPid";

function streamOf(): { emit(chunk: string): void; stream: EventEmitter } {
  const stream = new EventEmitter();
  return { stream, emit: (chunk) => stream.emit("data", Buffer.from(chunk)) };
}

describe("buildPidReportingScreenrecordArgs", () => {
  test("prints the shell pid then execs the recorder in one shell argument", () => {
    expect(
      buildPidReportingScreenrecordArgs(["screenrecord", "--bit-rate", "1", "/sdcard/a.mp4"]),
    ).toEqual(["shell", "echo $$; exec screenrecord --bit-rate 1 /sdcard/a.mp4"]);
  });
});

describe("trackDeviceRecorderPid", () => {
  test("reads the first stdout line, including CRLF endings", () => {
    const { stream, emit } = streamOf();
    const tracker = trackDeviceRecorderPid(stream);
    expect(tracker.pid).toBeUndefined();
    emit("4321\r\n");
    expect(tracker.pid).toBe(4321);
  });

  test("assembles a pid split across chunks and ignores later output", () => {
    const { stream, emit } = streamOf();
    const tracker = trackDeviceRecorderPid(stream);
    emit("43");
    expect(tracker.pid).toBeUndefined();
    emit("21\nrecorder says 99\n");
    emit("77\n");
    expect(tracker.pid).toBe(4321);
  });

  test.each([["warning: something\n"], ["0\n"], ["-5\n"], ["12 34\n"], ["\n"]])(
    "leaves the pid unknown for a first line of %j",
    (line) => {
      const { stream, emit } = streamOf();
      const tracker = trackDeviceRecorderPid(stream);
      emit(line);
      emit("4321\n");
      expect(tracker.pid).toBeUndefined();
    },
  );

  test("gives up on a long first line without a newline", () => {
    const { stream, emit } = streamOf();
    const tracker = trackDeviceRecorderPid(stream);
    emit("1".repeat(64));
    emit("\n4321\n");
    expect(tracker.pid).toBeUndefined();
  });
});

describe("isOwnRecorderCmdline", () => {
  const deviceFile = "/sdcard/auto-mobile-rec-1.mp4";

  test.each([
    [`screenrecord\u0000--bit-rate\u0000100\u0000${deviceFile}\u0000`, true],
    [`/system/bin/screenrecord\u0000${deviceFile}\u0000`, true],
    [`screenrecord\u0000--bit-rate\u0000100\u0000/sdcard/auto-mobile-other.mp4\u0000`, false],
    [`com.example.app\u0000${deviceFile}\u0000`, false],
    [`screenrecord-helper\u0000${deviceFile}\u0000`, false],
    ["", false],
  ])("cmdline %j -> %p", (cmdline, expected) => {
    expect(isOwnRecorderCmdline(cmdline, deviceFile)).toBe(expected);
  });
});
