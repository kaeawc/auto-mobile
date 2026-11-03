import { describe, expect, test } from "bun:test";
import {
  parseDeviceFrames,
  type DeviceFrame,
} from "../../../../src/features/prototype/web/deviceFrames";
import registry from "../../../../src/features/prototype/web/deviceFrames.json";
import {
  PROTOTYPE_WEB_3D_CSS,
  prototypeWeb3dBodyAttributes,
  prototypeWeb3dControls,
  prototypeWebFold,
  prototypeWebHingeLine,
  prototypeWebLeaves,
  prototypeWebOrbit,
  prototypeWebOrbitKey,
  prototypeWebPose,
  prototypeWebPostureAt,
} from "../../../../src/features/prototype/web/webDevice3d";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import {
  buildPrototypeWebPage,
  PROTOTYPE_WEB_RUNTIME,
} from "../../../../src/features/prototype/web/webPage";

const BOOK_POSTURES = [
  { posture: "closed", panel: "cover", hingeDegrees: 0 },
  { posture: "half_opened", panel: "inner", hingeDegrees: 90 },
  { posture: "opened", panel: "inner", hingeDegrees: 180 },
];

function parsedFrame(overrides: Record<string, unknown>): DeviceFrame {
  const parsed = parseDeviceFrames({
    frames: [{ ...structuredClone(registry.frames[0]), ...overrides }],
  });
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return parsed.data.frames[0]!;
}

const bookFrame = () =>
  parsedFrame({
    formFactor: "foldable",
    hinge: { axis: "vertical", positionDp: 200, widthDp: 12, occluding: true },
    postures: BOOK_POSTURES.filter((entry) => entry.panel === "inner"),
    source: { ...registry.frames[0].source, hinge: "test" },
  });

describe("prototype web 3D pose rules (#16458)", () => {
  test("pitch stops at ±80 and yaw stays continuous past a half turn", () => {
    expect(prototypeWebOrbit({ yaw: 190, pitch: 95 })).toEqual({ yaw: 190, pitch: 80 });
    expect(prototypeWebOrbit({ yaw: -190, pitch: -95 })).toEqual({ yaw: -190, pitch: -80 });
    expect(prototypeWebOrbit({ yaw: 30, pitch: 14 })).toEqual({ yaw: 30, pitch: 14 });
  });

  test("a flat hinge leaves the moving leaf unturned; shut turns it a half turn", () => {
    const orbit = { yaw: 30, pitch: 14 };
    expect(prototypeWebPose(orbit, 180, "vertical")).toEqual({
      device: "rotateX(-14deg) rotateY(30deg)",
      leaf: "rotateY(0deg)",
    });
    expect(prototypeWebPose(orbit, 0, "vertical").leaf).toBe("rotateY(-180deg)");
    expect(prototypeWebPose(orbit, 90, "horizontal").leaf).toBe("rotateX(90deg)");
  });

  test("past flat folds backwards, and the hinge stops at 0 and 360", () => {
    expect(prototypeWebPose({ yaw: 0, pitch: 0 }, 290, "vertical").leaf).toBe("rotateY(110deg)");
    expect(prototypeWebPose({ yaw: 0, pitch: 0 }, 400, "vertical").leaf).toBe("rotateY(180deg)");
    expect(prototypeWebPose({ yaw: 0, pitch: 0 }, -10, "horizontal").leaf).toBe("rotateX(180deg)");
  });

  test("the pose clamps pitch itself and keeps yaw continuous, so a step past 180° turns 5°", () => {
    expect(prototypeWebPose({ yaw: 180, pitch: -100 }, 180, "vertical").device).toBe(
      "rotateX(80deg) rotateY(180deg)",
    );
    expect(prototypeWebPose({ yaw: 185, pitch: 0 }, 180, "vertical").device).toBe(
      "rotateX(0deg) rotateY(185deg)",
    );
  });

  test("landscape turns the hinge line a quarter counterclockwise", () => {
    const book = { axis: "vertical" as const, at: 0.4 };
    const flip = { axis: "horizontal" as const, at: 0.3 };
    expect(prototypeWebHingeLine(book, "portrait")).toBe(book);
    expect(prototypeWebHingeLine(book, "landscape")).toEqual({ axis: "horizontal", at: 0.6 });
    expect(prototypeWebHingeLine(flip, "landscape")).toEqual({ axis: "vertical", at: 0.3 });
  });

  test("the hinge angle shows the layout of the frame's nearest posture", () => {
    expect(prototypeWebPostureAt(0, BOOK_POSTURES)).toBe("closed");
    expect(prototypeWebPostureAt(44, BOOK_POSTURES)).toBe("closed");
    expect(prototypeWebPostureAt(46, BOOK_POSTURES)).toBe("half_opened");
    expect(prototypeWebPostureAt(140, BOOK_POSTURES)).toBe("opened");
    expect(prototypeWebPostureAt(360, BOOK_POSTURES)).toBe("opened");
  });

  test("a tie keeps the posture listed first, and no postures shows none", () => {
    expect(prototypeWebPostureAt(45, BOOK_POSTURES)).toBe("closed");
    expect(prototypeWebPostureAt(90, [])).toBeUndefined();
  });

  test("arrow keys orbit by 5°, 15° with Shift; other keys do nothing", () => {
    expect(prototypeWebOrbitKey("ArrowLeft", false)).toEqual({ yaw: -5, pitch: 0 });
    expect(prototypeWebOrbitKey("ArrowUp", true)).toEqual({ yaw: 0, pitch: 15 });
    expect(prototypeWebOrbitKey("Enter", false)).toBeUndefined();
  });

  test("a book splits at the hinge into a left fixed leaf and a right moving leaf", () => {
    expect(prototypeWebLeaves(400, 300, { axis: "vertical", at: 0.25 })).toEqual({
      flip: "rotateY(180deg)",
      clip: "inset(0 300px 0 0)",
      fixed: { width: "100px", height: "300px" },
      fixedCorners: "0 R R 0",
      moving: { left: "100px", width: "300px", height: "300px" },
      origin: "0 50%",
      movingCorners: "R 0 0 R",
      clone: { left: "-100px" },
    });
  });

  test("a flip splits into a top fixed leaf and a bottom moving leaf", () => {
    const leaves = prototypeWebLeaves(200, 400, { axis: "horizontal", at: 0.5 });
    expect(leaves.clip).toBe("inset(0 0 200px 0)");
    expect(leaves.moving).toEqual({ top: "200px", width: "200px", height: "200px" });
    expect(leaves.origin).toBe("50% 0");
    expect(leaves.clone).toEqual({ top: "-200px" });
  });
});

describe("prototype web 3D page wiring (#16458)", () => {
  test("a frame folds from its hinge centre and its postures", () => {
    const fold = prototypeWebFold(bookFrame());
    const width = registry.frames[0].screen.widthDp;
    expect(fold?.hinge).toEqual({ axis: "vertical", at: Math.round((206 / width) * 1e4) / 1e4 });
    expect(fold?.postures).toEqual([
      { posture: "half_opened", hingeDegrees: 90 },
      { posture: "opened", hingeDegrees: 180 },
    ]);
  });

  test("a frame without a hinge or without postures does not fold", () => {
    expect(prototypeWebFold(parsedFrame({}))).toBeUndefined();
    const hingeOnly = parsedFrame({
      hinge: { axis: "vertical", positionDp: 200, widthDp: 0, occluding: false },
      source: { ...registry.frames[0].source, hinge: "test" },
    });
    expect(prototypeWebFold(hingeOnly)).toBeUndefined();
  });

  test("a frame that does not fold gets only the hidden 3D toggle", () => {
    const html = prototypeWeb3dControls(undefined).map(toHtml).join("");
    expect(html).toBe(
      '<button aria-label="3D view" aria-pressed="false" data-3d-control="" data-control="3d" hidden="" type="button">3D</button>',
    );
    expect(prototypeWeb3dBodyAttributes(undefined)).toBe("");
  });

  test("a folding frame adds a labelled posture select, a 0–360 hinge range and a status line", () => {
    const fold = prototypeWebFold(bookFrame());
    const html = prototypeWeb3dControls(fold).map(toHtml).join("");
    expect(html).toContain(
      '<select aria-label="Posture" data-3d-control="" data-control="posture" hidden="">',
    );
    expect(html).toContain('<option data-hinge="180" selected="" value="opened">opened</option>');
    expect(html).toContain(
      '<input data-control="hinge" max="360" min="0" step="5" type="range" value="180">',
    );
    expect(html).toContain('role="status"');
    expect(prototypeWeb3dBodyAttributes(fold)).toBe(
      ` data-hinge-axis="vertical" data-hinge-at="${fold?.hinge.at}"`,
    );
  });

  test("3D CSS applies only while wrapped, honours reduced motion and hides without CSS 3D", () => {
    expect(PROTOTYPE_WEB_3D_CSS).toContain(
      "@supports not (transform-style:preserve-3d){[data-3d-control]{display:none!important}}",
    );
    expect(PROTOTYPE_WEB_3D_CSS).toContain("[data-device3d] [data-viewport]{perspective:");
    expect(PROTOTYPE_WEB_3D_CSS).toContain(
      "@media (prefers-reduced-motion:reduce){[data-orbit],[data-leaf]{transition:none}}",
    );
  });

  test("the page offers the 3D toggle and inlines the 3D rules in its one script", () => {
    const page = buildPrototypeWebPage({
      title: "t",
      variants: [
        { id: "a", label: "a", revisions: [{ revision: 1, operation: "show", spec: {} }] },
      ],
    });
    const shell = page.html.slice(0, page.html.indexOf("<script"));
    expect(shell).toContain('data-control="3d"');
    expect(shell).not.toContain('data-control="posture"');
    expect(shell).not.toContain("data-hinge-axis");
    expect(page.html.match(/<script/g)).toHaveLength(1);
    for (const rule of [
      "prototypeWeb3dRuntime",
      "prototypeWebPose",
      "prototypeWebOrbit",
      "prototypeWebHingeLine",
      "prototypeWebPostureAt",
      "prototypeWebLeaves",
      "prototypeWeb3dWrap",
      "prototypeWeb3dUnwrap",
    ]) {
      expect(PROTOTYPE_WEB_RUNTIME).toContain(`function ${rule}(`);
    }
  });
});
