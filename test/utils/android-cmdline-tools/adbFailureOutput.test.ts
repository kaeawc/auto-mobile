import { describe, expect, test } from "bun:test";
import {
  adbFailureOutput,
  isPidofNoMatch,
} from "../../../src/utils/android-cmdline-tools/adbFailureOutput";
import { wrapCommandError } from "../../../src/utils/CommandError";
import {
  adbRejectionFromInstallCapture,
  readAndroidInstallCapture,
} from "../../helpers/androidInstallCapture";

describe("adbFailureOutput", () => {
  const capture = readAndroidInstallCapture("downgrade-over-newer.txt");

  test("reads the streams of a real wrapCommandError rejection from its cause", () => {
    const output = adbFailureOutput(adbRejectionFromInstallCapture(capture));
    expect(output.stdout.trim()).toBe(capture.stdout);
    expect(output.stderr.trim()).toBe(capture.stderr);
  });

  test("never reads the message, which echoes the command line", () => {
    const output = adbFailureOutput(new Error("Command failed: adb install /tmp/secret.apk"));
    expect(output).toEqual({ stdout: "", stderr: "" });
  });

  test("returns empty streams for a non-error value", () => {
    expect(adbFailureOutput("boom")).toEqual({ stdout: "", stderr: "" });
  });
});

describe("isPidofNoMatch", () => {
  test.each([
    { code: 1, stdout: "", stderr: "", expected: true },
    { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), expected: true },
    { code: 1, stdout: "4242", stderr: "", expected: false },
    { code: 1, stdout: "", stderr: "device offline", expected: false },
    { code: 255, stdout: "", stderr: "", expected: false },
    { code: "ENOENT", stdout: "", stderr: "", expected: false },
  ])("classifies raw and wrapped failures (%j)", ({ expected, ...fields }) => {
    const raw = Object.assign(new Error("pidof failed"), fields);
    expect(isPidofNoMatch(raw)).toBe(expected);
    expect(isPidofNoMatch(wrapCommandError(raw, { command: "adb" }))).toBe(expected);
  });

  test("requires a structured exit status", () => {
    expect(isPidofNoMatch(new Error("pidof failed with exit code: 1"))).toBe(false);
    expect(isPidofNoMatch(undefined)).toBe(false);
  });
});
