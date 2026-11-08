import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWatchFaceState,
  readWearServiceDumpsys,
  type WearServiceAdb,
} from "../../../src/features/wear/wearServiceDumpsys";
import type { ExecResult } from "../../../src/models";

// Verbatim Wear OS 7.0 / API 37 emulator capture from #17519.
const capture = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/wear-service/ambient-readback.txt"),
  "utf8",
);
const lines = capture.split("\n").filter((line) => line.length > 0);
const line = (prefix: string) => {
  const found = lines.find((candidate) => candidate.startsWith(prefix));
  if (!found) {
    throw new Error(`fixture line missing: ${prefix}`);
  }
  return found;
};

describe("dumpsys wear_service watch-face state", () => {
  test("fixture keeps its eight captured lines", () => {
    expect(lines).toHaveLength(8);
  });

  test("after KEYCODE_SLEEP: visible face in ambient", () => {
    expect(parseWatchFaceState(lines[3] ?? "")).toEqual({
      watchFaceVisible: true,
      inAmbient: true,
    });
  });

  test("after KEYCODE_WAKEUP: visible face out of ambient", () => {
    expect(parseWatchFaceState(lines[6] ?? "")).toEqual({
      watchFaceVisible: true,
      inAmbient: false,
    });
  });

  test("Settings in front: face not visible, not ambient", () => {
    expect(parseWatchFaceState(line("face not on screen"))).toEqual({
      watchFaceVisible: false,
      inAmbient: false,
    });
  });

  test.each([
    line("before:"),
    line("after KEYCODE_SLEEP:"),
    lines[2] ?? "",
    line("after KEYCODE_WAKEUP:"),
    lines[5] ?? "",
  ])("line without watchFaceState is no reading: %s", (text) => {
    expect(parseWatchFaceState(text)).toBeNull();
  });

  test.each([
    "Can't find service: wear_service",
    "watchFaceState=WatchFaceState{watchFaceVisible=true}",
    "watchFaceState=WatchFaceState{watchFaceVisible=true, inAmbient=maybe}",
  ])("malformed or absent state is null: %s", (text) => {
    expect(parseWatchFaceState(text)).toBeNull();
  });

  test("reads once over adb shell and returns stdout", async () => {
    const calls: string[][] = [];
    const adb: WearServiceAdb = {
      execute: async (args): Promise<ExecResult> => {
        calls.push(args);
        return {
          stdout: lines[3] ?? "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
    };
    expect(parseWatchFaceState(await readWearServiceDumpsys(adb))?.inAmbient).toBe(true);
    expect(calls).toEqual([["shell", "dumpsys", "wear_service"]]);
  });
});
