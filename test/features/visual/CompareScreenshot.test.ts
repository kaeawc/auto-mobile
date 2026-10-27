import { beforeEach, describe, expect, test } from "bun:test";
import {
  CompareScreenshot,
  type CompareScreenshotRequest,
  type VisualScreen,
} from "../../../src/features/visual/CompareScreenshot";
import type { VisualDeviceProfile } from "../../../src/features/visual/VisualDeviceProfile";
import { SharpBackend } from "../../../src/utils/image/backend/SharpBackend";
import { FakeVisualBaselineStore } from "../../fakes/FakeVisualBaselineStore";
import { solidPng, type Rgba } from "../../helpers/pngFixtures";

const LIGHT: Rgba = [255, 255, 255, 255];
const DARK: Rgba = [20, 20, 20, 255];
const RED: Rgba = [255, 0, 0, 255];

const PROFILE: VisualDeviceProfile = {
  platform: "android",
  width: 10,
  height: 20,
  density: 420,
  fontScale: 1,
  theme: "light",
};

function screen(png: Buffer, systemBars: VisualScreen["systemBars"] = []): VisualScreen {
  return {
    png,
    geometry: { platform: "android", screenSize: { width: 10, height: 20 } },
    systemBars,
    resolveElement: (elementId) => {
      if (elementId === "card") {
        return { left: 2, top: 4, right: 8, bottom: 10 };
      }
      throw new Error(`compareScreenshot element '${elementId}' was not found with bounds`);
    },
  };
}

describe("CompareScreenshot (#14083)", () => {
  let store: FakeVisualBaselineStore;
  let current: VisualScreen;
  let profile: VisualDeviceProfile;
  let written: Map<string, Buffer>;

  const run = (request: Omit<CompareScreenshotRequest, "baseline"> & { baseline?: string }) =>
    new CompareScreenshot({
      capture: async () => current,
      profile: async () => profile,
      store,
      backend: new SharpBackend(),
      writeFile: async (filePath, data) => {
        written.set(filePath, data);
      },
      now: () => "2026-10-21T00:00:00.000Z",
    }).execute({ baseline: "home", ...request });

  beforeEach(() => {
    store = new FakeVisualBaselineStore();
    current = screen(solidPng(10, 20, LIGHT));
    profile = PROFILE;
    written = new Map();
  });

  test("record then compare on an unchanged screen matches", async () => {
    expect(await run({ mode: "record" })).toMatchObject({
      status: "recorded",
      match: true,
      baselinePath: "/baselines/home/android-10x20-d420-f1-light.png",
    });
    const result = await run({ mode: "compare" });
    expect(result).toMatchObject({ status: "compared", match: true, diffRatio: 0 });
    expect(written.size).toBe(0);
  });

  test("a theme change does not match and writes a diff image", async () => {
    await run({ mode: "record" });
    current = screen(solidPng(10, 20, DARK));
    const result = await run({ mode: "compare" });
    expect(result).toMatchObject({
      status: "compared",
      match: false,
      diffRatio: 1,
      diffImagePath: "/baselines/home/android-10x20-d420-f1-light.diff.png",
    });
    expect([...written.keys()]).toEqual(["/baselines/home/android-10x20-d420-f1-light.diff.png"]);
  });

  test("masked regions are ignored", async () => {
    await run({ mode: "record" });
    current = screen(solidPng(10, 20, LIGHT, [{ x: 5, y: 15, color: RED }]));
    expect(await run({ mode: "compare" })).toMatchObject({ match: false });
    expect(
      await run({ mode: "compare", mask: [{ rect: { left: 4, top: 14, right: 6, bottom: 16 } }] }),
    ).toMatchObject({ match: true });
    expect(await run({ mode: "compare", mask: [{ elementId: "card" }] })).toMatchObject({
      match: false,
    });
  });

  test("system bars are ignored by default and compared when ignoreSystemBars is false", async () => {
    const bars = [{ left: 0, top: 0, right: 10, bottom: 2 }];
    current = screen(solidPng(10, 20, LIGHT), bars);
    await run({ mode: "record" });
    current = screen(solidPng(10, 20, LIGHT, [{ x: 1, y: 0, color: RED }]), bars);
    expect(await run({ mode: "compare" })).toMatchObject({ match: true });
    expect(await run({ mode: "compare", ignoreSystemBars: false })).toMatchObject({
      match: false,
    });
  });

  test("an element target compares only that element's crop", async () => {
    await run({ mode: "record", target: { elementId: "card" } });
    current = screen(solidPng(10, 20, LIGHT, [{ x: 0, y: 19, color: RED }]));
    expect(await run({ mode: "compare", target: { elementId: "card" } })).toMatchObject({
      match: true,
      comparedPixels: 36,
    });
    current = screen(solidPng(10, 20, LIGHT, [{ x: 3, y: 5, color: RED }]));
    expect(await run({ mode: "compare", target: { elementId: "card" } })).toMatchObject({
      match: false,
    });
  });

  test("a baseline from a different device profile is refused with a typed error", async () => {
    await run({ mode: "record" });
    profile = { ...PROFILE, theme: "dark", fontScale: 1.3 };
    const result = await run({ mode: "compare" });
    expect(result).toMatchObject({
      status: "failed",
      match: false,
      errorCode: "baseline_profile_mismatch",
      otherProfiles: [PROFILE],
    });
    if (result.status !== "failed") {
      throw new Error("expected a failure");
    }
    expect(result.error).toContain("fontScale: baseline 1 vs device 1.3");
    expect(result.error).toContain("theme: baseline light vs device dark");
  });

  test("a missing baseline is a typed error; recordIfMissing records it once", async () => {
    expect(await run({ mode: "compare" })).toMatchObject({ errorCode: "baseline_missing" });
    expect(await run({ mode: "recordIfMissing" })).toMatchObject({ status: "recorded" });
    current = screen(solidPng(10, 20, DARK));
    expect(await run({ mode: "recordIfMissing" })).toMatchObject({
      status: "compared",
      match: false,
    });
  });

  test("a target that changed size is a typed size mismatch", async () => {
    await run({ mode: "record", target: { rect: { left: 0, top: 0, right: 4, bottom: 4 } } });
    expect(
      await run({ mode: "compare", target: { rect: { left: 0, top: 0, right: 5, bottom: 4 } } }),
    ).toMatchObject({ status: "failed", errorCode: "size_mismatch" });
  });

  test("an unsafe baseline name is rejected before any capture", async () => {
    let captured = false;
    const compare = new CompareScreenshot({
      capture: async () => {
        captured = true;
        return current;
      },
      profile: async () => profile,
      store,
      backend: new SharpBackend(),
      writeFile: async () => {},
      now: () => "",
    });
    await expect(compare.execute({ baseline: "../etc", mode: "record" })).rejects.toThrow(
      "Baseline name",
    );
    expect(captured).toBe(false);
  });
});
