import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdbWatchFaceReader } from "../../../src/features/wear/WatchFace";
import {
  parseWatchFaces,
  splitWearServiceSections,
  type WearServiceAdb,
} from "../../../src/features/wear/wearServiceDumpsys";
import { ActionableError, type ExecResult } from "../../../src/models";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/wear/wear-service", name), "utf8");

// The excerpt attached to #17518, and whole captures, all from a Wear OS 7.0 / API 37 emulator.
const issueExcerpt = fixture("issue-17518-watch-faces-excerpt.txt");
const interactiveCapture = fixture("interactive-watch-face.txt");
const ambientCapture = fixture("ambient-after-sleep.txt");

const DAY_AND_DATE =
  "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.DayAndDateProviderService";
const CAPTURED_SLOTS = [
  { slot: 11, type: 1, provider: null },
  { slot: 12, type: 3, provider: DAY_AND_DATE },
];
const CAPTURED_FAVORITES = [
  { favoriteId: 1, package: "com.google.wear.offhand", slots: CAPTURED_SLOTS },
  { favoriteId: 2, package: "com.google.wear.superficial", slots: [] },
  { favoriteId: 3, package: "com.google.wear.perfunctory", slots: CAPTURED_SLOTS },
];

function stdoutAdb(stdout: string, calls: string[][] = []): WearServiceAdb {
  return {
    execute: async (args): Promise<ExecResult> => {
      calls.push(args);
      return {
        stdout,
        stderr: "",
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (text) => stdout.includes(text),
      };
    },
  };
}

describe("parseWatchFaces", () => {
  test("issue excerpt: active face, favorites with slots, ambient", () => {
    expect(parseWatchFaces(issueExcerpt)).toEqual({
      activeFace: { package: "com.google.wear.offhand", favoriteId: 1, fallback: false },
      favorites: CAPTURED_FAVORITES,
      ambient: false,
    });
  });

  test.each([
    ["interactive watch face", interactiveCapture, false],
    ["ambient after sleep", ambientCapture, true],
  ])("whole %s capture, complications section before watch_faces", (_name, capture, ambient) => {
    expect(parseWatchFaces(capture)).toEqual({
      activeFace: { package: "com.google.wear.offhand", favoriteId: 1, fallback: false },
      favorites: CAPTURED_FAVORITES,
      ambient,
    });
  });

  test("the GMS favorite list after the database block is not read as favorites", () => {
    const watchFaces = splitWearServiceSections(interactiveCapture).get("watch_faces") ?? [];
    expect(watchFaces.some((line) => line.includes("id=1 componentName="))).toBe(true);
    expect(parseWatchFaces(interactiveCapture)?.favorites).toHaveLength(3);
  });

  test("without the complications section, slots are the stored ones and ambient is absent", () => {
    const watchFacesOnly = issueExcerpt.slice(
      0,
      issueExcerpt.indexOf("Wear Service API: complications"),
    );
    expect(parseWatchFaces(watchFacesOnly)).toEqual({
      activeFace: { package: "com.google.wear.offhand", favoriteId: 1, fallback: false },
      favorites: CAPTURED_FAVORITES,
    });
  });

  test("live ComplicationsConfigController slots win for the active favorite only", () => {
    const edited = issueExcerpt.replace(
      "id=1 slot=11 type=1 configActionPending=false provider=null isEnabled=true",
      "id=1 slot=11 type=5 configActionPending=false provider=ComponentInfo{com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.BatteryProviderService} isEnabled=true",
    );
    const favorites = parseWatchFaces(edited)?.favorites;
    expect(favorites?.[0].slots[0]).toEqual({
      slot: 11,
      type: 5,
      provider:
        "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.BatteryProviderService",
    });
    expect(favorites?.[2].slots).toEqual(CAPTURED_SLOTS);
  });

  test("a fallback face keeps stored slots and is flagged", () => {
    const fallback = issueExcerpt.replace("isFallbackWatchFace=false", "isFallbackWatchFace=true");
    expect(parseWatchFaces(fallback)?.activeFace.fallback).toBe(true);
  });

  test.each([
    "",
    "Can't find service: wear_service",
    issueExcerpt.replace("Wear Service API: watch_faces", "Wear Service API: other"),
    issueExcerpt.replace(/^activeWatchFaceComponent=.*$/m, ""),
  ])("missing section or unparseable output is null (%#)", (text) => {
    expect(parseWatchFaces(text)).toBeNull();
  });
});

describe("AdbWatchFaceReader", () => {
  test("reads dumpsys wear_service once and reports the observation", async () => {
    const calls: string[][] = [];
    const result = await new AdbWatchFaceReader(stdoutAdb(issueExcerpt, calls)).observe();
    expect(calls).toEqual([["shell", "dumpsys", "wear_service"]]);
    expect(result).toMatchObject({
      success: true,
      action: "watchFace",
      available: true,
      activeFace: { package: "com.google.wear.offhand", favoriteId: 1, fallback: false },
      favorites: CAPTURED_FAVORITES,
      ambient: false,
    });
    expect(result.message).toContain("com.google.wear.offhand (favorite 1)");
  });

  test("unparseable output is a typed unavailable result, not an exception", async () => {
    const result = await new AdbWatchFaceReader(
      stdoutAdb("Can't find service: wear_service"),
    ).observe();
    expect(result).toMatchObject({ success: false, action: "watchFace", available: false });
    expect(result.reason).toContain("watch_faces");
    expect(result.activeFace).toBeUndefined();
  });

  test("an adb failure is an actionable error", async () => {
    const adb: WearServiceAdb = {
      execute: async () => {
        throw new Error("device offline");
      },
    };
    await expect(new AdbWatchFaceReader(adb).observe()).rejects.toBeInstanceOf(ActionableError);
  });

  test("an aborted signal stops before adb runs", async () => {
    const calls: string[][] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      new AdbWatchFaceReader(stdoutAdb(issueExcerpt, calls)).observe(controller.signal),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
