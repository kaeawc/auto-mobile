import { beforeEach, describe, expect, test } from "bun:test";
import {
  AdbRotaryScroller,
  parseWmSize,
  swipeCommand,
} from "../../../src/features/wear/RotaryScroll";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

function exec(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s) => stdout.includes(s),
  };
}

/** Fake adb: commands matching a rule run its effect; unmatched ones succeed with no output. */
class FakeRotaryAdb implements AdbCommandRunner {
  readonly commands: string[] = [];
  readonly rules: Array<{ pattern: RegExp; run: () => string }> = [];
  screen = "list@0";

  async executeCommand(command: string, _options?: AdbExecuteOptions): Promise<ExecResult> {
    this.commands.push(command);
    if (command === "shell wm size") {
      return exec("Physical size: 384x384\n");
    }
    const rule = this.rules.find((candidate) => candidate.pattern.test(command));
    return exec(rule ? rule.run() : "");
  }

  on(pattern: RegExp, run: () => string) {
    this.rules.push({ pattern, run });
  }
}

let adb: FakeRotaryAdb;
let timer: FakeTimer;

function scroller(deviceId = "emulator-5554") {
  return new AdbRotaryScroller({
    adb,
    timer,
    deviceId,
    fingerprint: async () => adb.screen,
  });
}

beforeEach(() => {
  adb = new FakeRotaryAdb();
  timer = new FakeTimer();
  timer.enableAutoAdvance();
});

describe("rotary scroll", () => {
  test("stops at the first candidate whose read-back changed the screen", async () => {
    adb.on(/rotaryencoder scroll 3$/, () => {
      adb.screen = "list@3";
      return "";
    });

    const result = await scroller().scroll({ delta: 3 });

    expect(result.success).toBe(true);
    expect(result.method).toBe("input_rotaryencoder");
    expect(result.attempts).toEqual([
      {
        method: "input_rotaryencoder",
        command: "shell input rotaryencoder scroll 3",
        outcome: "scrolled",
      },
    ]);
    expect(adb.commands.some((command) => command.includes("input swipe"))).toBe(false);
  });

  test("falls through failed and unchanged candidates to the swipe", async () => {
    adb.on(/rotaryencoder/, () => "Error: unknown source rotaryencoder");
    adb.on(/^emu event send/, () => "OK");
    adb.on(/input swipe/, () => {
      adb.screen = "list@swiped";
      return "";
    });

    const result = await scroller().scroll({ delta: 2 });

    expect(result.success).toBe(true);
    expect(result.method).toBe("swipe");
    expect(result.attempts.map((a) => [a.method, a.outcome])).toEqual([
      ["input_rotaryencoder", "failed"],
      ["emulator_rotary", "unchanged"],
      ["swipe", "scrolled"],
    ]);
    expect(result.attempts[0].error).toContain("unknown source");
  });

  test("reports every attempt when nothing moves the screen", async () => {
    const result = await scroller().scroll({ delta: -1 });

    expect(result.success).toBe(false);
    expect(result.method).toBeUndefined();
    expect(result.attempts.map((a) => a.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(result.reason).toContain("No rotary candidate");
  });

  test("skips the emulator console on a physical device serial", async () => {
    const result = await scroller("R5CT1234").scroll({ delta: 1 });

    expect(result.attempts.map((a) => a.method)).toEqual(["input_rotaryencoder", "swipe"]);
    expect(adb.commands.some((command) => command.startsWith("emu "))).toBe(false);
  });

  test("a command that throws is an attempt, not a failure of the call", async () => {
    const throwing: AdbCommandRunner = {
      executeCommand: async (command) => {
        if (command.includes("rotaryencoder")) {
          throw new Error("device offline");
        }
        return adb.executeCommand(command);
      },
    };
    adb.on(/input swipe/, () => {
      adb.screen = "moved";
      return "";
    });
    const result = await new AdbRotaryScroller({
      adb: throwing,
      timer,
      deviceId: "R5CT1234",
      fingerprint: async () => adb.screen,
    }).scroll({ delta: 1 });

    expect(result.success).toBe(true);
    expect(result.attempts[0].outcome).toBe("failed");
    expect(result.attempts[0].error).toContain("device offline");
  });

  test("refuses to guess when the screen cannot be read", async () => {
    const result = await new AdbRotaryScroller({
      adb,
      timer,
      deviceId: "emulator-5554",
      fingerprint: async () => undefined,
    }).scroll({ delta: 1 });

    expect(result.success).toBe(false);
    expect(result.attempts).toEqual([]);
    expect(adb.commands).toEqual([]);
  });
});

describe("swipe geometry", () => {
  test("a positive delta moves the finger up, a negative one down", () => {
    expect(swipeCommand({ width: 400, height: 400 }, 2)).toBe(
      "shell input swipe 200 240 200 160 250",
    );
    expect(swipeCommand({ width: 400, height: 400 }, -2)).toBe(
      "shell input swipe 200 160 200 240 250",
    );
  });

  test("a large delta is capped at 80% of the screen height", () => {
    expect(swipeCommand({ width: 400, height: 400 }, 50)).toBe(
      "shell input swipe 200 360 200 40 250",
    );
  });

  test("parseWmSize prefers the override size", () => {
    expect(parseWmSize("Physical size: 384x384\nOverride size: 300x300\n")).toEqual({
      width: 300,
      height: 300,
    });
    expect(parseWmSize("garbage")).toBeUndefined();
  });
});
