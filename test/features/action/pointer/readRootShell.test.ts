import { describe, expect, test } from "bun:test";
import {
  needsRootProbe,
  readRootShell,
} from "../../../../src/features/action/pointer/readPointerEnvironment";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";

describe("readRootShell (#13105)", () => {
  test("is true only when adb shell runs as uid 0", async () => {
    for (const [stdout, expected] of [
      ["0\n", true],
      ["2000\n", false],
      ["", false],
    ] as const) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell id -u", createExecResult(stdout, ""));
      expect(await readRootShell(adb)).toBe(expected);
    }
  });

  test("an unreadable uid counts as no root", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("shell id -u", new Error("device offline"));
    expect(await readRootShell(adb)).toBe(false);
  });
});

describe("needsRootProbe", () => {
  test("skips the uid read when the runner advertises both pointer capabilities", () => {
    expect(needsRootProbe(new Set(["stylus_input_v1", "hover_input_v1"]))).toBe(false);
    expect(needsRootProbe(new Set(["stylus_input_v1"]))).toBe(true);
    expect(needsRootProbe(new Set(["hover_input_v1"]))).toBe(true);
    expect(needsRootProbe(new Set())).toBe(true);
  });

  test("always reads the uid for an eraser: only the uinput route injects one (#13105)", () => {
    expect(needsRootProbe(new Set(["stylus_input_v1", "hover_input_v1"]), "eraser")).toBe(true);
    expect(needsRootProbe(new Set(["stylus_input_v1", "hover_input_v1"]), "stylus")).toBe(false);
  });
});
