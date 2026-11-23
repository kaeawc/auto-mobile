import { describe, expect, test } from "bun:test";
import {
  IosSimulatorScreenControls,
  hasScreenControlField,
} from "../../../src/features/utility/IosSimulatorScreenControls";
import type { SimCtl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { SimulatorBacklight } from "../../../src/utils/ios-cmdline-tools/SimulatorBacklight";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "994D7AD5-32E6-43AA-BB3E-CE61A8D277A1";

/** `defaults` and `notifyutil` over SpringBoard state; a backlight change lands after N reads. */
class FakeSpringBoard implements Pick<SimCtl, "executeCommandArgs"> {
  suppressed: boolean | null = null;
  blanked = false;
  readonly calls: string[][] = [];
  failWrites = false;

  executeCommandArgs: SimCtl["executeCommandArgs"] = async (args) => {
    this.calls.push(args);
    const [, , tool, verb] = args;
    if (tool === "notifyutil") {
      return createExecResult(
        `com.apple.springboard.hasBlankedScreen ${this.blanked ? 1 : 0}\n`,
        "",
      );
    }
    if (tool === "defaults" && verb === "read") {
      if (this.suppressed === null) {
        throw new Error(
          "The domain/default pair of (com.apple.springboard, SBSuppressDynamicIslandCompletely) does not exist",
        );
      }
      return createExecResult(`${this.suppressed ? 1 : 0}\n`, "");
    }
    if (this.failWrites) {
      throw new Error("CoreSimulator service unavailable");
    }
    if (tool === "defaults" && verb === "write") {
      this.suppressed = args.at(-1) === "YES";
      return createExecResult("", "");
    }
    if (tool === "defaults" && verb === "delete") {
      if (this.suppressed === null) {
        throw new Error(
          "Could not find key 'SBSuppressDynamicIslandCompletely' in domain 'com.apple.springboard'.",
        );
      }
      this.suppressed = null;
      return createExecResult("", "");
    }
    throw new Error(`unexpected simctl ${args.join(" ")}`);
  };

  writes(): string[][] {
    return this.calls.filter((args) => args[3] === "write" || args[3] === "delete");
  }
}

/** Records calls; turning the display off reports as blanked only after `lag` reads. */
class FakeBacklight implements SimulatorBacklight {
  readonly calls: boolean[] = [];
  failure?: Error;

  constructor(
    private readonly springBoard: FakeSpringBoard,
    private readonly lagReads = 0,
  ) {}

  async setActive(udid: string, active: boolean): Promise<void> {
    expect(udid).toBe(UDID);
    this.calls.push(active);
    if (this.failure) {
      throw this.failure;
    }
    if (active || this.lagReads === 0) {
      this.springBoard.blanked = !active;
      return;
    }
    let remaining = this.lagReads;
    const original = this.springBoard.executeCommandArgs;
    this.springBoard.executeCommandArgs = async (args) => {
      if (args[2] === "notifyutil" && --remaining === 0) {
        this.springBoard.blanked = true;
        this.springBoard.executeCommandArgs = original;
      }
      return original(args);
    };
  }
}

function controls(
  springBoard: FakeSpringBoard,
  backlight: SimulatorBacklight,
  timer = autoTimer(),
) {
  return new IosSimulatorScreenControls(UDID, springBoard, { backlight, timer });
}

function autoTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

describe("IosSimulatorScreenControls (#19018)", () => {
  test("reads an unset island default as visible and a lit display as on", async () => {
    const springBoard = new FakeSpringBoard();

    const values = await controls(springBoard, new FakeBacklight(springBoard)).read();

    expect(values).toEqual({ dynamicIsland: "visible", backlight: true });
  });

  test("hidden writes the SpringBoard default and visible deletes it", async () => {
    const springBoard = new FakeSpringBoard();
    const subject = controls(springBoard, new FakeBacklight(springBoard));

    const hidden = await subject.set({ dynamicIsland: "hidden" });
    const shown = await subject.set({ dynamicIsland: "visible" });

    expect(hidden).toEqual({
      previous: { dynamicIsland: "visible", backlight: true },
      applied: { dynamicIsland: "hidden", backlight: true },
      errors: [],
    });
    expect(shown.applied.dynamicIsland).toBe("visible");
    expect(springBoard.writes()).toEqual([
      [
        "spawn",
        UDID,
        "defaults",
        "write",
        "com.apple.springboard",
        "SBSuppressDynamicIslandCompletely",
        "-bool",
        "YES",
      ],
      [
        "spawn",
        UDID,
        "defaults",
        "delete",
        "com.apple.springboard",
        "SBSuppressDynamicIslandCompletely",
      ],
    ]);
  });

  test("visible on a Simulator with no island default is already satisfied", async () => {
    const springBoard = new FakeSpringBoard();

    const result = await controls(springBoard, new FakeBacklight(springBoard)).set({
      dynamicIsland: "visible",
    });

    expect(result.errors).toEqual([]);
  });

  test("backlight off waits for SpringBoard to report the blanked display", async () => {
    const springBoard = new FakeSpringBoard();
    const backlight = new FakeBacklight(springBoard, 3);
    const timer = autoTimer();

    const result = await controls(springBoard, backlight, timer).set({ backlight: false });

    expect(backlight.calls).toEqual([false]);
    expect(result.applied.backlight).toBe(false);
    expect(result.errors).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([250, 250]);
  });

  test("a display that never reports off fails after a bounded wait", async () => {
    const springBoard = new FakeSpringBoard();
    const backlight: SimulatorBacklight = { setActive: async () => {} };
    const timer = autoTimer();

    const result = await controls(springBoard, backlight, timer).set({ backlight: false });

    expect(result.errors).toEqual(["Simulator backlight remained on after requesting off"]);
    expect(timer.getSleepHistory()).toHaveLength(12);
  });

  test("a failed backlight call is returned beside the previous values", async () => {
    const springBoard = new FakeSpringBoard();
    const backlight = new FakeBacklight(springBoard);
    backlight.failure = new Error("CoreSimulator.framework could not be loaded");

    const result = await controls(springBoard, backlight).set({ backlight: false });

    expect(result.previous).toEqual({ dynamicIsland: "visible", backlight: true });
    expect(result.errors[0]).toBe("CoreSimulator.framework could not be loaded");
  });

  test("a failed island write is reported, not thrown", async () => {
    const springBoard = new FakeSpringBoard();
    springBoard.failWrites = true;

    const result = await controls(springBoard, new FakeBacklight(springBoard)).set({
      dynamicIsland: "hidden",
    });

    expect(result.errors).toEqual([
      "Setting the Dynamic Island hidden failed: CoreSimulator service unavailable",
      "Dynamic Island remained visible after requesting hidden",
    ]);
  });

  test("reset shows a hidden island and relights an off display", async () => {
    const springBoard = new FakeSpringBoard();
    springBoard.suppressed = true;
    springBoard.blanked = true;
    const backlight = new FakeBacklight(springBoard);

    const result = await controls(springBoard, backlight).set({}, true);

    expect(result).toEqual({
      previous: { dynamicIsland: "hidden", backlight: false },
      applied: { dynamicIsland: "visible", backlight: true },
      errors: [],
    });
    expect(backlight.calls).toEqual([true]);
  });

  test("reset leaves a Simulator already in the default state untouched", async () => {
    const springBoard = new FakeSpringBoard();
    const backlight = new FakeBacklight(springBoard);

    const result = await controls(springBoard, backlight).set({}, true);

    expect(result.errors).toEqual([]);
    expect(springBoard.writes()).toEqual([]);
    expect(backlight.calls).toEqual([]);
  });

  test("hasScreenControlField names only the two fields", () => {
    expect(hasScreenControlField({})).toBe(false);
    expect(hasScreenControlField({ backlight: false })).toBe(true);
    expect(hasScreenControlField({ dynamicIsland: "visible" })).toBe(true);
  });
});
