import { describe, expect, test } from "bun:test";
import {
  DEVICE_FRAMES,
  deviceFrameOrThrow,
  defaultDeviceFrameId,
  normalizeDeviceFrame,
} from "../../../../src/features/prototype/web/deviceFrames";
import {
  deviceFrameProblems,
  orphanDeviceFrameSources,
  parseDeviceFrames,
  type DeviceFrameEntry,
  withDeviceFrameSources,
} from "../../../../src/features/prototype/web/deviceFrameSchema";
import rawRegistry from "../../../../src/features/prototype/web/deviceFrames.json";
import sources from "../../../../src/features/prototype/web/deviceFrameSources.json";

const registry = withDeviceFrameSources(rawRegistry, sources);

const frame = (overrides: Record<string, unknown> = {}) => ({
  ...structuredClone(registry.frames[0]),
  ...overrides,
});

describe("device frame registry (#16346)", () => {
  test("every checked-in frame is valid", () => {
    expect(deviceFrameProblems(registry)).toEqual([]);
    expect(DEVICE_FRAMES.length).toBe(registry.frames.length);
  });

  test("keeps each frame's source in the sources file, not the registry (#16809)", () => {
    expect(rawRegistry.frames.filter((entry) => "source" in entry)).toEqual([]);
    expect(orphanDeviceFrameSources(rawRegistry, sources)).toEqual([]);
    expect(orphanDeviceFrameSources(rawRegistry, { ...sources, "nokia-3310": {} })).toEqual([
      "sources.nokia-3310: names no frame",
    ]);
  });

  test("a frame with no sources entry is invalid", () => {
    const rest = Object.fromEntries(
      Object.entries(sources).filter(([id]) => id !== rawRegistry.frames[0].id),
    );
    expect(parseDeviceFrames(withDeviceFrameSources(rawRegistry, rest)).success).toBe(false);
  });

  test("ships at least one Android and one iOS frame, with platform defaults", () => {
    expect(deviceFrameOrThrow(defaultDeviceFrameId("android")).platform).toBe("android");
    expect(deviceFrameOrThrow(defaultDeviceFrameId("ios")).platform).toBe("ios");
  });

  test("an unknown frame lists the valid ids", () => {
    expect(() => deviceFrameOrThrow("nokia-3310")).toThrow(
      `Unknown device frame "nokia-3310". Valid frames: ${DEVICE_FRAMES.map((f) => f.id).join(", ")}`,
    );
  });

  test("rejects duplicate ids", () => {
    expect(deviceFrameProblems({ frames: [frame(), frame()] })).toEqual([
      `frames[1].id: duplicate id "${registry.frames[0].id}"`,
    ]);
  });

  test("rejects a cutout outside the screen", () => {
    const cutout = { type: "punchHole", centerXDp: 1000, centerYDp: 20, radiusDp: 10 };
    expect(deviceFrameProblems({ frames: [frame({ cutout })] })).toEqual([
      "frames[0].cutout: lies outside the portrait screen",
    ]);
  });

  test("rejects safe areas that leave no screen", () => {
    const safeArea = {
      portrait: { top: 500, bottom: 500, left: 0, right: 0 },
      landscape: { top: 0, bottom: 0, left: 0, right: 0 },
    };
    expect(deviceFrameProblems({ frames: [frame({ safeArea })] })).toEqual([
      "frames[0].safeArea.portrait: insets leave no screen",
    ]);
  });

  test("rejects unknown fields and a missing source", () => {
    const withoutSource: Record<string, unknown> = frame();
    delete withoutSource.source;
    expect(parseDeviceFrames({ frames: [withoutSource] }).success).toBe(false);
    expect(parseDeviceFrames({ frames: [frame({ extra: true })] }).success).toBe(false);
  });
});

const coverPanel = () => ({
  role: "cover",
  screen: { widthDp: 360, heightDp: 800, density: 2.625 },
  cornerRadiusDp: 24,
  cutout: { type: "none" },
  statusBarDp: 32,
  navBar: { type: "gesture", heightDp: 24 },
  safeArea: {
    portrait: { top: 32, bottom: 24, left: 0, right: 0 },
    landscape: { top: 32, bottom: 24, left: 0, right: 0 },
  },
});

const foldable = (overrides: Record<string, unknown> = {}) =>
  frame({
    formFactor: "foldable",
    panels: [coverPanel()],
    hinge: { axis: "vertical", positionDp: 205, widthDp: 0, occluding: false },
    postures: [
      { posture: "closed", panel: "cover", hingeDegrees: 0 },
      { posture: "half_opened", panel: "inner", hingeDegrees: 90 },
      { posture: "opened", panel: "inner", hingeDegrees: 180 },
    ],
    source: {
      ...registry.frames[0].source,
      hinge: "pixel_fold hardware profile",
      kinds: { screen: "avdProfile", insets: "measured", hinge: "avdProfile" },
    },
    ...overrides,
  });

describe("device frame schema v2 (#16444)", () => {
  test("a v1 entry parses as a phone with one inner panel and v2 defaults", () => {
    const parsed = parseDeviceFrames({ frames: [frame()] });
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const [v2] = parsed.data.frames;
    const v1 = registry.frames[0];
    expect(v2.formFactor).toBe("phone");
    expect(v2.mask).toBe("rect");
    expect(v2.input).toBe("touch");
    expect(v2.postures).toEqual([]);
    expect(v2.hinge).toBeUndefined();
    const { screen, cornerRadiusDp, cutout, statusBarDp, navBar, safeArea } = v1;
    const innerPanel: unknown = JSON.parse(JSON.stringify(v2.panels));
    expect(innerPanel).toEqual([
      { role: "inner", screen, cornerRadiusDp, cutout, statusBarDp, navBar, safeArea },
    ]);
  });

  test("every checked-in phone and tablet normalizes to one inner panel; foldables add a cover", () => {
    expect(DEVICE_FRAMES.map((f) => f.panels.map((panel) => panel.role))).toEqual(
      DEVICE_FRAMES.map((f) => (f.formFactor === "foldable" ? ["inner", "cover"] : ["inner"])),
    );
    expect(DEVICE_FRAMES.filter((f) => f.formFactor === "foldable").map((f) => f.id)).toEqual([
      "pixel-fold",
      "flip-foldable",
    ]);
  });

  test("a foldable's unmeasured geometry says so in its source (#16445)", () => {
    const parsed = parseDeviceFrames(registry);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const foldables = parsed.data.frames.filter((f) => f.formFactor === "foldable");
    expect(foldables.length).toBe(2);
    for (const { source } of foldables) {
      const { kinds } = source;
      expect(kinds?.hinge).toBeDefined();
      for (const field of ["screen", "insets", "hinge"] as const) {
        if (kinds?.[field] !== "measured") {
          expect(source[field]).toContain("not yet measured");
        }
      }
    }
  });

  test("accepts a foldable with a cover panel, hinge, postures and source kinds", () => {
    expect(deviceFrameProblems({ frames: [foldable()] })).toEqual([]);
    const parsed = parseDeviceFrames({ frames: [foldable()] });
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    expect(parsed.data.frames[0].panels.map((panel) => panel.role)).toEqual(["inner", "cover"]);
    expect(parsed.data.frames[0].hinge?.panel).toBe("inner");
  });

  test("the zod-free registry normalizes exactly as the schema parses (#16451)", () => {
    const entries = [...registry.frames, foldable(), frame({ formFactor: "watch", mask: "round" })];
    const parsed = parseDeviceFrames({ frames: entries });
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    expect((entries as DeviceFrameEntry[]).map(normalizeDeviceFrame)).toEqual(parsed.data.frames);
    const unsourced = parsed.data.frames.map(({ source: _source, ...rest }) => rest);
    expect(DEVICE_FRAMES).toEqual(unsourced.slice(0, registry.frames.length));
  });

  test("accepts a round rotary watch and a dpad TV", () => {
    const watch = frame({ formFactor: "watch", mask: "round", input: "rotary" });
    const tv = frame({ id: "tv", formFactor: "tv", input: "dpad" });
    expect(deviceFrameProblems({ frames: [watch, tv] })).toEqual([]);
  });

  test("rejects a posture naming a panel the frame does not have", () => {
    const postures = [{ posture: "closed", panel: "rear", hingeDegrees: 0 }];
    expect(deviceFrameProblems({ frames: [foldable({ postures })] })).toEqual([
      'frames[0].postures[0].panel: the frame has no "rear" panel',
    ]);
  });

  test("rejects a posture listed twice", () => {
    const postures = [
      { posture: "opened", panel: "inner", hingeDegrees: 180 },
      { posture: "opened", panel: "cover", hingeDegrees: 180 },
    ];
    expect(deviceFrameProblems({ frames: [foldable({ postures })] })).toEqual([
      'frames[0].postures[1].posture: duplicate posture "opened"',
    ]);
  });

  test("rejects a hinge outside its panel, on either axis", () => {
    const { widthDp, heightDp } = registry.frames[0].screen;
    const vertical = { axis: "vertical", positionDp: widthDp - 10, widthDp: 10, occluding: true };
    const horizontal = { axis: "horizontal", positionDp: heightDp, widthDp: 0, occluding: false };
    const atEdge = { axis: "vertical", positionDp: 0, widthDp: 0, occluding: false };
    for (const hinge of [vertical, horizontal, atEdge]) {
      expect(deviceFrameProblems({ frames: [foldable({ hinge })] })).toEqual([
        'frames[0].hinge: lies outside its "inner" panel',
      ]);
    }
  });

  test("checks the hinge against the panel it names", () => {
    const hinge = {
      axis: "vertical",
      panel: "cover",
      positionDp: 300,
      widthDp: 0,
      occluding: false,
    };
    expect(deviceFrameProblems({ frames: [foldable({ hinge })] })).toEqual([]);
    const outside = { ...hinge, positionDp: 400 };
    expect(deviceFrameProblems({ frames: [foldable({ hinge: outside })] })).toEqual([
      'frames[0].hinge: lies outside its "cover" panel',
    ]);
    const missing = { ...hinge, panel: "rear" };
    expect(deviceFrameProblems({ frames: [foldable({ hinge: missing })] })).toEqual([
      'frames[0].hinge.panel: the frame has no "rear" panel',
    ]);
  });

  test("a hinge needs a source", () => {
    const source = registry.frames[0].source;
    expect(deviceFrameProblems({ frames: [foldable({ source })] })).toEqual([
      "frames[0].source.hinge: a hinge needs a source",
    ]);
  });

  test("runs the cutout and safe-area checks on every panel", () => {
    const cover = {
      ...coverPanel(),
      cutout: { type: "punchHole", centerXDp: 1000, centerYDp: 20, radiusDp: 10 },
      safeArea: {
        portrait: { top: 400, bottom: 400, left: 0, right: 0 },
        landscape: { top: 0, bottom: 0, left: 0, right: 0 },
      },
    };
    expect(deviceFrameProblems({ frames: [foldable({ panels: [cover] })] })).toEqual([
      "frames[0].panels[0].cutout: lies outside the portrait screen",
      "frames[0].panels[0].safeArea.portrait: insets leave no screen",
    ]);
  });

  test("rejects a second panel with the same role and an extra inner panel", () => {
    expect(
      deviceFrameProblems({ frames: [foldable({ panels: [coverPanel(), coverPanel()] })] }),
    ).toEqual(['frames[0].panels[1].role: duplicate panel role "cover"']);
    const inner = { ...coverPanel(), role: "inner" };
    expect(parseDeviceFrames({ frames: [foldable({ panels: [inner] })] }).success).toBe(false);
  });

  test("rejects unknown v2 values", () => {
    const bad = [
      { formFactor: "unknown" },
      { mask: "hexagon" },
      { input: "mouse" },
      { postures: [{ posture: "unknown", panel: "inner", hingeDegrees: 0 }] },
      { source: { ...registry.frames[0].source, kinds: { screen: "guess" } } },
      { panels: [{ ...coverPanel(), role: "overlay" }] },
    ];
    for (const overrides of bad) {
      expect(parseDeviceFrames({ frames: [foldable(overrides)] }).success).toBe(false);
    }
  });
});

describe("watch, TV and car frames (#16446)", () => {
  const byId = (id: string) => deviceFrameOrThrow(id);

  test("each matches its provisioned profile's form factor, mask and input", () => {
    expect(
      ["wearos-small-round", "apple-watch", "android-tv-1080p", "apple-tv", "car-1024p-landscape"]
        .map(byId)
        .map(({ id, platform, formFactor, mask, input }) => ({
          id,
          platform,
          formFactor,
          mask,
          input,
        })),
    ).toEqual([
      {
        id: "wearos-small-round",
        platform: "android",
        formFactor: "watch",
        mask: "round",
        input: "rotary",
      },
      { id: "apple-watch", platform: "ios", formFactor: "watch", mask: "rect", input: "rotary" },
      {
        id: "android-tv-1080p",
        platform: "android",
        formFactor: "tv",
        mask: "rect",
        input: "dpad",
      },
      { id: "apple-tv", platform: "ios", formFactor: "tv", mask: "rect", input: "dpad" },
      {
        id: "car-1024p-landscape",
        platform: "android",
        formFactor: "automotive",
        mask: "rect",
        input: "touch",
      },
    ]);
  });

  test("watches and TVs have no system bars; every new frame says where its geometry came from", () => {
    // Provenance lives in the sources file, merged in by frame id (#16809).
    const screenKind = (id: string) => {
      const source = registry.frames.find((frame) => frame.id === id)?.source;
      return source && "kinds" in source ? source.kinds.screen : undefined;
    };
    for (const id of ["wearos-small-round", "apple-watch", "android-tv-1080p", "apple-tv"]) {
      expect(byId(id)).toMatchObject({ statusBarDp: 0, navBar: { type: "none" } });
    }
    expect(screenKind("wearos-small-round")).toBe("avdProfile");
    expect(screenKind("apple-watch")).toBe("simulatorProfile");
    expect(screenKind("android-tv-1080p")).toBe("avdProfile");
    expect(screenKind("apple-tv")).toBe("simulatorProfile");
    expect(screenKind("car-1024p-landscape")).toBe("avdProfile");
  });

  test("a landscape-only frame records its geometry in portrait", () => {
    for (const id of ["android-tv-1080p", "apple-tv", "car-1024p-landscape"]) {
      const { widthDp, heightDp } = byId(id).screen;
      expect(widthDp).toBeLessThan(heightDp);
    }
  });
});
