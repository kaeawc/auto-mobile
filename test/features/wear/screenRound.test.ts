import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdbScreenRoundReader, parseScreenRound } from "../../../src/features/wear/screenRound";
import type { AdbCommandRunner } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

// Hand-reconstructed fixtures; see the header of each file.
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/wear-os", name), "utf8");

describe("parseScreenRound", () => {
  test("is true when the default display carries FLAG_ROUND", () => {
    expect(parseScreenRound(fixture("dumpsys-display-round.txt"))).toBe(true);
  });

  test("is false for a display record without the flag", () => {
    expect(parseScreenRound(fixture("dumpsys-display-rect.txt"))).toBe(false);
  });

  test("is undefined when no display record is present", () => {
    expect(parseScreenRound("Display Manager State:\n")).toBeUndefined();
  });

  test("ignores FLAG_ROUND on a secondary display", () => {
    const output = [
      'mBaseDisplayInfo=DisplayInfo{"Main", displayId 0, FLAG_TRUSTED, real 1 x 1}',
      'mBaseDisplayInfo=DisplayInfo{"Other", displayId 2, FLAG_ROUND, real 1 x 1}',
    ].join("\n");
    expect(parseScreenRound(output)).toBe(false);
  });
});

describe("AdbScreenRoundReader", () => {
  test("reads once and caches a definite answer", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell dumpsys display", {
      stdout: fixture("dumpsys-display-round.txt"),
      stderr: "",
      toString: () => "",
      trim: () => "",
      includes: () => false,
    });
    const reader = new AdbScreenRoundReader(adb);
    expect(await reader.isScreenRound()).toBe(true);
    expect(await reader.isScreenRound()).toBe(true);
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("returns undefined and retries when the read fails", async () => {
    let calls = 0;
    const adb: AdbCommandRunner = {
      executeCommand: async () => {
        calls += 1;
        throw new Error("boom");
      },
    };
    const reader = new AdbScreenRoundReader(adb);
    expect(await reader.isScreenRound()).toBeUndefined();
    expect(await reader.isScreenRound()).toBeUndefined();
    expect(calls).toBe(2);
  });
});
