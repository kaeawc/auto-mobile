import { describe, expect, test } from "bun:test";
import { validateListing } from "../../scripts/store-listing/storeListing";
import {
  buildScreenshotPlan,
  PROFILES,
  SAMPLE_LIBRARY,
  toDrivePlan,
  type PlanPins,
} from "../../scripts/store-listing/screenshotPlan";
import { manifestFor, parseArgs } from "../../scripts/store-listing/capture-screenshots";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pins: PlanPins = { androidSerial: "emulator-5600", iosUdid: "UDID-1" };
const plan = buildScreenshotPlan(pins);

describe("screenshot plan", () => {
  test("covers every profile, both appearances and four screens", () => {
    expect(plan).toHaveLength(PROFILES.length * 2 * 4);
    expect(new Set(plan.map((shot) => shot.screen))).toEqual(
      new Set(["library", "viewer", "import", "share"]),
    );
  });

  test("ids and destinations are unique, so no shot overwrites another", () => {
    expect(new Set(plan.map((shot) => shot.id)).size).toBe(plan.length);
    expect(new Set(plan.map((shot) => shot.destination)).size).toBe(plan.length);
  });

  test("Android shots land in the Play screenshot folders and iOS in the screenshots folder", () => {
    const find = (id: string) => plan.find((shot) => shot.id === id)?.destination;
    expect(find("android-phone-light-library")).toBe(
      "android/en-US/images/phoneScreenshots/01_library_light.png",
    );
    expect(find("android-7in-dark-share")).toBe(
      "android/en-US/images/sevenInchScreenshots/04_share_dark.png",
    );
    expect(find("android-10in-light-viewer")).toBe(
      "android/en-US/images/tenInchScreenshots/02_viewer_light.png",
    );
    expect(find("ios-iphone-69-dark-import")).toBe(
      "ios/en-US/screenshots/ios-iphone-69_03_import_dark.png",
    );
  });

  test("every destination is accepted by the listing validator", () => {
    const files = new Map<string, string>([
      ["android/en-US/title.txt", "ProtoViewer\n"],
      ["android/en-US/short_description.txt", "Short.\n"],
      ["android/en-US/full_description.txt", "Full.\n"],
      ["android/en-US/changelogs/default.txt", "New.\n"],
      ["ios/en-US/name.txt", "ProtoViewer\n"],
      ["ios/en-US/subtitle.txt", "Prototypes\n"],
      ["ios/en-US/description.txt", "Full.\n"],
      ["ios/en-US/keywords.txt", "design\n"],
      ["ios/en-US/release_notes.txt", "New.\n"],
      ["ios/en-US/privacy_url.txt", "https://example.com/p\n"],
      ["ios/en-US/support_url.txt", "https://example.com/s\n"],
      ["ios/review_information/notes.txt", "Notes.\n"],
    ]);
    plan.forEach((shot) => files.set(shot.destination, ""));
    expect(validateListing(files)).toEqual([]);
  });

  test("steps fix the clock, seed the sample library and end with a settled capture", () => {
    plan.forEach((shot) => {
      const tools = shot.steps.flatMap((step) => (step.kind === "mcp" ? [step.tool] : []));
      expect(tools[0]).toBe(shot.profile.platform === "android" ? "getAndroid" : "getApple");
      expect(tools).toContain("statusBar");
      expect(tools.indexOf("putAppFile")).toBeGreaterThan(tools.indexOf("terminateApp"));
      const last = shot.steps[shot.steps.length - 1];
      expect(last).toEqual({
        kind: "mcp",
        tool: "observe",
        args: { screenshot: "settled", settled: true },
      });
    });
  });

  test("every sample prototype in the library exists in the shared valid corpus", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    SAMPLE_LIBRARY.forEach((entry) => {
      expect(existsSync(join(repoRoot, entry.file))).toBe(true);
    });
  });

  test("appearance is a host step pinned to the device, and the drive plan excludes it", () => {
    const shot = plan.find((entry) => entry.id === "android-phone-dark-library");
    expect(shot?.steps[1]).toEqual({
      kind: "host",
      argv: ["adb", "-s", "emulator-5600", "shell", "cmd", "uimode", "night", "yes"],
      note: "set Android night mode dark",
    });
    const ios = plan.find((entry) => entry.id === "ios-iphone-69-light-library");
    expect(ios?.steps[1]).toMatchObject({
      argv: ["xcrun", "simctl", "ui", "UDID-1", "appearance", "light"],
    });
    expect(toDrivePlan(shot!).every((step) => step.tool !== "adb")).toBe(true);
    expect(toDrivePlan(shot!)).toHaveLength(shot!.steps.length - 1);
  });

  test("the plan is deterministic", () => {
    expect(buildScreenshotPlan(pins)).toEqual(plan);
  });
});

describe("capture-screenshots", () => {
  test("parses flags", () => {
    expect(parseArgs(["--emit", "out", "--android-serial", "a", "--ios-udid", "u"])).toEqual({
      list: false,
      emit: "out",
      pins: { androidSerial: "a", iosUdid: "u" },
    });
    expect(parseArgs(["--list"]).list).toBe(true);
  });

  test("the manifest lists host steps and expected pixels per shot", () => {
    const manifest = manifestFor(pins);
    expect(manifest).toHaveLength(plan.length);
    expect(manifest[0]).toMatchObject({
      id: "android-phone-light-library",
      plan: "android-phone-light-library.plan.json",
      pixels: { width: 1080, height: 2400 },
    });
    expect(manifest[0]?.hostSteps).toHaveLength(1);
  });
});
