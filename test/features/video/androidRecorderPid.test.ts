import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  buildPidReportingScreenrecordArgs,
  isOwnRecorderCmdline,
  parseRecorderLookup,
  trackDeviceRecorderPid,
  type RecorderLookup,
} from "../../../src/features/video/androidRecorderPid";

function streamOf(): { emit(chunk: string): void; stream: EventEmitter } {
  const stream = new EventEmitter();
  return { stream, emit: (chunk) => stream.emit("data", Buffer.from(chunk)) };
}

describe("buildPidReportingScreenrecordArgs", () => {
  test("detaches the pid-reporting shell with setsid and falls back on older images", () => {
    expect(
      buildPidReportingScreenrecordArgs(["screenrecord", "--bit-rate", "1", "/sdcard/a.mp4"]),
    ).toEqual([
      "shell",
      "if command -v setsid >/dev/null 2>&1; then setsid sh -c 'echo $$; exec screenrecord --bit-rate 1 /sdcard/a.mp4'; s=$?; case $s in 126|127) ;; *) exit $s;; esac; fi; echo $$; exec screenrecord --bit-rate 1 /sdcard/a.mp4",
    ]);
  });

  test.each(["screen'record", "/sdcard/it's.mp4"])(
    "rejects single quotes in argv token %p",
    (token) => {
      expect(() => buildPidReportingScreenrecordArgs(["screenrecord", token])).toThrow(
        "Android screenrecord argv must not contain single quotes.",
      );
    },
  );
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

describe("parseRecorderLookup", () => {
  const deviceFile = "/sdcard/auto-mobile-rec-1.mp4";
  const ours = `pid:4321:screenrecord\u0000--bit-rate\u0000100\u0000${deviceFile}\u0000`;
  const other = "pid:9999:screenrecord\u0000/sdcard/auto-mobile-other.mp4\u0000";

  test.each<[string, RecorderLookup]>([
    [`${other}\n${ours}\npidof-status:0\n`, { kind: "found", pid: 4321 }],
    [`${ours}\r\npidof-status:0\r\n`, { kind: "found", pid: 4321 }],
    [`${other}\npidof-status:0\n`, { kind: "none" }],
    ["pid:4321:\npidof-status:0\n", { kind: "none" }],
    ["pidof-status:1\n", { kind: "none" }],
    [`${ours}\n`, { kind: "unknown" }],
    ["sh: pidof: not found\npidof-status:127\n", { kind: "unknown" }],
    ["", { kind: "unknown" }],
  ])("parses %j", (stdout, expected) => {
    expect(parseRecorderLookup(stdout, deviceFile)).toEqual(expected);
  });
});
