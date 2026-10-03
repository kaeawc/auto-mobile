import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdbAndroidHingeAngleConsole,
  parseEmulatorHingeAngleReadback,
} from "../../../src/features/device/AndroidHingeAngleConsole";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const captured = fixture("hinge-angle0-get.txt");

describe("Android hinge angle read-back", () => {
  test.each([captured, captured.replace(/\n/g, "\r\n"), captured.trimEnd() + "  \n"])(
    "parses captured output %j",
    (stdout) => {
      expect(parseEmulatorHingeAngleReadback(stdout)).toEqual({ ok: true, degrees: 180 });
    },
  );
  test.each([
    "",
    "KO: unknown sensor",
    captured + captured,
    "hinge-angle1 = 180",
    "hinge-angle0 = unknown",
    "hinge-angle0 = " + "9".repeat(400),
  ])("rejects malformed output %j", (stdout) => {
    expect(parseEmulatorHingeAngleReadback(stdout)).toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });
  test("console reads the captured angle with no retry and the request signal", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("emu sensor get hinge-angle0", createExecResult(captured, ""));
    const execute = spyOn(adb, "executeCommand");
    const signal = new AbortController().signal;
    try {
      expect(await new AdbAndroidHingeAngleConsole().getHingeAngle(adb, { signal })).toEqual({
        ok: true,
        degrees: 180,
      });
      expect(execute.mock.calls).toEqual([
        ["emu sensor get hinge-angle0", undefined, undefined, true, signal],
      ]);
    } finally {
      execute.mockRestore();
    }
  });
  test.each(["stdout", "stderr"] as const)(
    "console preserves the first failure line from %s",
    async (channel) => {
      const adb = new FakeAdbExecutor();
      const failure = "  KO: unknown sensor";
      adb.setCommandResponse(
        "emu sensor get",
        createExecResult(
          channel === "stdout" ? "\n" + failure + "\n" : "",
          channel === "stderr" ? "\n" + failure + "\n" : "",
        ),
      );
      expect(await new AdbAndroidHingeAngleConsole().getHingeAngle(adb)).toEqual({
        ok: false,
        reason: failure,
      });
    },
  );
});
