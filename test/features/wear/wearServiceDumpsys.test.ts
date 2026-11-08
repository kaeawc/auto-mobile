import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWatchFaceState,
  readWearServiceDumpsys,
  type WearServiceAdb,
} from "../../../src/features/wear/wearServiceDumpsys";
import type { ExecResult } from "../../../src/models";

// Whole raw dumpsys wear_service captures from a Wear OS 7.0 / API 37 emulator.
const ambientCapture = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/wear-service/ambient-after-sleep.txt"),
  "utf8",
);
const interactiveCapture = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/wear-service/interactive-watch-face.txt"),
  "utf8",
);
const settingsCapture = readFileSync(
  join(import.meta.dir, "../../fixtures/wear/wear-service/interactive-settings-front.txt"),
  "utf8",
);

describe("dumpsys wear_service watch-face state", () => {
  test.each([
    ["ambient after sleep", ambientCapture],
    ["interactive watch face", interactiveCapture],
    ["Settings in front", settingsCapture],
  ])("%s capture contains exactly one watchFaceState occurrence", (_name, capture) => {
    expect(capture.match(/watchFaceState=/g)).toHaveLength(1);
  });

  test("after KEYCODE_SLEEP: visible face in ambient", () => {
    expect(parseWatchFaceState(ambientCapture)).toEqual({
      watchFaceVisible: true,
      inAmbient: true,
    });
  });

  test("interactive watch face: visible face out of ambient", () => {
    expect(parseWatchFaceState(interactiveCapture)).toEqual({
      watchFaceVisible: true,
      inAmbient: false,
    });
  });

  test("Settings in front: face not visible, not ambient", () => {
    expect(parseWatchFaceState(settingsCapture)).toEqual({
      watchFaceVisible: false,
      inAmbient: false,
    });
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
          stdout: ambientCapture,
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
    };
    const stdout = await readWearServiceDumpsys(adb);
    expect(stdout).toBe(ambientCapture);
    expect(parseWatchFaceState(stdout)).toEqual({ watchFaceVisible: true, inAmbient: true });
    expect(calls).toEqual([["shell", "dumpsys", "wear_service"]]);
  });
});
