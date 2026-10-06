import { describe, expect, test } from "bun:test";
import { adbFailureOutput } from "../../../src/utils/android-cmdline-tools/adbFailureOutput";
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
