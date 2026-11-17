import { describe, expect, test } from "bun:test";
import {
  parseDeviceFrames,
  type DeviceFrame,
  withDeviceFrameSources,
} from "../../../../src/features/prototype/web/deviceFrameSchema";
import rawRegistry from "../../../../src/features/prototype/web/deviceFrames.json";
import sources from "../../../../src/features/prototype/web/deviceFrameSources.json";
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
  prototypeWebReflowPosture,
  prototypeWeb3dLayoutReflow,
  type PrototypeWebReflowSelect,
} from "../../../../src/features/prototype/web/webDevice3d";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import {
  buildPrototypeWebPage,
  PROTOTYPE_WEB_RUNTIME,
} from "../../../../src/features/prototype/web/webPage";

const registry = withDeviceFrameSources(rawRegistry, sources);

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

  test("a fold reflows to a posture view the page has and does not show (#16458)", () => {
    const views = ["opened", "half_opened", "closed"];
    expect(prototypeWebReflowPosture("half_opened", "opened", views)).toBe("half_opened");
    expect(prototypeWebReflowPosture("opened", "half_opened", views)).toBe("opened");
    expect(prototypeWebReflowPosture("opened", "opened", views)).toBeUndefined();
    expect(prototypeWebReflowPosture("tent", "opened", views)).toBeUndefined();
    expect(prototypeWebReflowPosture(undefined, "opened", views)).toBeUndefined();
  });

  test("shutting never reflows to the cover panel's closed view", () => {
    expect(prototypeWebReflowPosture("closed", "half_opened", ["half_opened", "closed"])).toBe(
      undefined,
    );
  });

  test("the reflow rule is self-contained, as the inlined runtime needs", () => {
    const inlined = new Function(`return (${prototypeWebReflowPosture.toString()})`)() as (
      ...args: Parameters<typeof prototypeWebReflowPosture>
    ) => string | undefined;
    expect(inlined("half_opened", "opened", ["half_opened"])).toBe("half_opened");
  });

  test("a reflow chooses the posture with the framing kept, and leaving restores posture and screen", () => {
    const changes: string[] = [];
    /** A fake 2D select that records each change and whether framing was kept. */
    const select = (name: string, value: string, values: string[]): PrototypeWebReflowSelect => {
      const fake: PrototypeWebReflowSelect = {
        value,
        options: values.map((option) => ({ value: option })),
        dataset: {},
        dispatchEvent: () => {
          const kept = fake.dataset.keepFraming === undefined ? "" : " (kept)";
          changes.push(`${name}=${fake.value}${kept}`);
          return true;
        },
      };
      return fake;
    };
    const postures = select("posture", "opened", ["opened", "half_opened", "closed"]);
    const screens = select("screen", "detail", ["home", "detail"]);
    const reflow = prototypeWeb3dLayoutReflow(
      {
        querySelector: (selector) =>
          selector.includes("layout-posture")
            ? postures
            : selector.includes("screen")
              ? screens
              : null,
      },
      prototypeWebReflowPosture,
    );
    reflow.enter("opened");
    reflow.reflow("opened");
    reflow.reflow("half_opened");
    // The half_opened stack has no detail screen, so the 2D runtime moved it to the start.
    screens.value = "home";
    reflow.reflow("closed");
    reflow.leave();
    expect(changes).toEqual([
      "posture=half_opened (kept)",
      "posture=opened (kept)",
      "screen=detail (kept)",
    ]);
    expect(postures.dataset.keepFraming).toBeUndefined();
  });

  test("leaving does not choose a screen the restored posture no longer offers", () => {
    const changes: string[] = [];
    const fake = (value: string, values: string[]): PrototypeWebReflowSelect => ({
      value,
      options: values.map((option) => ({ value: option })),
      dataset: {},
      dispatchEvent: () => changes.push(value) > 0,
    });
    // Entered on detail; the restored posture's stack offers only home now.
    const screens = fake("detail", ["home"]);
    const reflow = prototypeWeb3dLayoutReflow(
      { querySelector: (selector) => (selector.includes("screen") ? screens : null) },
      prototypeWebReflowPosture,
    );
    reflow.enter(undefined);
    screens.value = "home";
    reflow.leave();
    expect(changes).toEqual([]);
  });

  test("arrow keys orbit by 5°, 15° with Shift; other keys do nothing", () => {
    expect(prototypeWebOrbitKey("ArrowLeft", false)).toEqual({ yaw: -5, pitch: 0 });
    expect(prototypeWebOrbitKey("ArrowUp", true)).toEqual({ yaw: 0, pitch: 15 });
    expect(prototypeWebOrbitKey("Enter", false)).toBeUndefined();
  });

  test("a book splits at the hinge into a left fixed leaf and a right moving leaf", () => {
    expect(
      prototypeWebLeaves(
        400,
        300,
        { axis: "vertical", at: 0.25 },
        { left: 0, top: 0, width: 400, height: 300 },
      ),
    ).toEqual({
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
    const leaves = prototypeWebLeaves(
      200,
      400,
      { axis: "horizontal", at: 0.5 },
      { left: 0, top: 0, width: 200, height: 400 },
    );
    expect(leaves.clip).toBe("inset(0 0 200px 0)");
    expect(leaves.moving).toEqual({ top: "200px", width: "200px", height: "200px" });
    expect(leaves.origin).toBe("50% 0");
    expect(leaves.clone).toEqual({ top: "-200px" });
  });

  test("an off-centre hinge behind a bezel splits on the screen's hinge, not the frame's share (#16768)", () => {
    // A 12 px bezel around a 400 × 300 screen: the hinge a quarter across the screen is 112 px
    // into the 424 px frame, where a share of the frame box would put it 106 px in.
    const book = prototypeWebLeaves(
      424,
      324,
      { axis: "vertical", at: 0.25 },
      { left: 12, top: 12, width: 400, height: 300 },
    );
    expect(book.clip).toBe("inset(0 312px 0 0)");
    expect(book.fixed).toEqual({ width: "112px", height: "324px" });
    expect(book.moving).toEqual({ left: "112px", width: "312px", height: "324px" });
    expect(book.clone).toEqual({ left: "-112px" });
    const flip = prototypeWebLeaves(
      324,
      424,
      { axis: "horizontal", at: 0.75 },
      { left: 12, top: 12, width: 300, height: 400 },
    );
    expect(flip.clip).toBe("inset(0 0 112px 0)");
    expect(flip.moving).toEqual({ top: "312px", width: "324px", height: "112px" });
    expect(flip.clone).toEqual({ top: "-312px" });
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

  test("without a flat posture the select starts on the posture the flat hinge shows", () => {
    const fold = {
      hinge: { axis: "horizontal" as const, at: 0.5 },
      postures: [
        { posture: "closed", hingeDegrees: 0 },
        { posture: "half_opened", hingeDegrees: 150 },
      ],
    };
    const html = prototypeWeb3dControls(fold).map(toHtml).join("");
    expect(html).toContain('<option data-hinge="150" selected="" value="half_opened">');
    expect(html).not.toContain('data-hinge="0" selected=""');
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
