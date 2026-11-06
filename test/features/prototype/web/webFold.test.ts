import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deviceFrameOrThrow,
  type DeviceFrame,
} from "../../../../src/features/prototype/web/deviceFrames";
import {
  defaultFramePosture,
  frameInPosture,
  framePostures,
  hingeBand,
  layoutSize,
  webFold,
} from "../../../../src/features/prototype/web/webFold";
import { renderDeviceFrame } from "../../../../src/features/prototype/web/webFrame";
import {
  el,
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

const reference = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const findAll = (node: WebChild, match: (element: WebElement) => boolean): WebElement[] =>
  typeof node === "string"
    ? []
    : [...(match(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, match))];
const chrome = (node: WebChild, name: string) =>
  findAll(node, (element) => element.attrs["data-chrome"] === name);
const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

/** A spec whose only text reports the platform state the still decides. */
const probe = {
  id: "posture-probe",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "text",
    testTag: "label",
    text: "{platform:/device/widthClass}|{platform:/device/posture}",
  },
};
const label = (options: Parameters<typeof renderPrototypeStill>[1]) => {
  const [node] = findAll(
    renderPrototypeStill(probe, options).element,
    (element) => element.attrs["data-testid"] === "label",
  );
  return textOf(node!);
};

/** The Pixel Fold with an occluding hinge, for the layout a seamless registry fold never takes. */
function occludingFold(): DeviceFrame {
  const frame = deviceFrameOrThrow("pixel-fold");
  return { ...frame, hinge: { ...frame.hinge!, positionDp: 410, widthDp: 20, occluding: true } };
}

describe("foldable postures (#16445)", () => {
  test("both foldables list closed, half-opened and opened, and open by default", () => {
    for (const id of ["pixel-fold", "flip-foldable"]) {
      const frame = deviceFrameOrThrow(id);
      expect(frame.formFactor).toBe("foldable");
      expect(framePostures(frame)).toEqual(["closed", "half_opened", "opened"]);
      expect(defaultFramePosture(frame)).toBe("opened");
    }
    expect(defaultFramePosture(deviceFrameOrThrow("pixel-9"))).toBeUndefined();
  });

  test("closed draws the cover panel without the hinge; opened draws the hinged inner panel", () => {
    const fold = deviceFrameOrThrow("pixel-fold");
    const closed = frameInPosture(fold, "closed");
    expect(closed.panel).toBe("cover");
    expect(closed.frame.screen).toEqual(fold.panels[1]!.screen);
    expect(closed.hinge).toBeUndefined();
    const opened = frameInPosture(fold);
    expect(opened.posture).toBe("opened");
    expect(opened.frame.screen).toEqual(fold.screen);
    expect(opened.hingeDegrees).toBe(180);
  });

  test("a posture the frame lacks lists the valid ones; a frame without postures takes none", () => {
    expect(() => frameInPosture(deviceFrameOrThrow("pixel-fold"), "tent")).toThrow(
      'no posture "tent". Valid postures: closed, half_opened, opened',
    );
    expect(() => frameInPosture(deviceFrameOrThrow("pixel-9"), "opened")).toThrow(
      "has no postures",
    );
    expect(frameInPosture(deviceFrameOrThrow("pixel-9")).posture).toBeUndefined();
  });

  test("landscape turns a vertical hinge horizontal from the far edge, and a horizontal one vertical", () => {
    const book = frameInPosture(occludingFold(), "half_opened");
    expect(hingeBand(book, "portrait")).toEqual({ axis: "vertical", startDp: 410, widthDp: 20 });
    expect(hingeBand(book, "landscape")).toEqual({
      axis: "horizontal",
      startDp: 841 - 410 - 20,
      widthDp: 20,
    });
    const flip = frameInPosture(deviceFrameOrThrow("flip-foldable"), "half_opened");
    expect(hingeBand(flip, "landscape")).toEqual({ axis: "vertical", startDp: 502, widthDp: 0 });
  });

  test("an occluding hinge leaves the panel minus its width; a seamless fold the whole panel", () => {
    const occluding = webFold(frameInPosture(occludingFold()), "portrait");
    expect(layoutSize({ width: 841, height: 701 }, occluding)).toEqual({ width: 821, height: 701 });
    const landscape = webFold(frameInPosture(occludingFold()), "landscape");
    expect(layoutSize({ width: 701, height: 841 }, landscape)).toEqual({ width: 701, height: 821 });
    const seamless = webFold(frameInPosture(deviceFrameOrThrow("pixel-fold")), "portrait");
    expect(seamless?.occluding).toBe(false);
    expect(layoutSize({ width: 841, height: 701 }, seamless)).toEqual({ width: 841, height: 701 });
  });
});

describe("foldable stills (#16445)", () => {
  test("the posture sets the active panel's width class and Android's posture", () => {
    expect(label({ frame: "pixel-fold" })).toBe("expanded|flat");
    expect(label({ frame: "pixel-fold", posture: "half_opened" })).toBe("expanded|book");
    expect(label({ frame: "pixel-fold", posture: "closed" })).toBe("compact|");
    expect(label({ frame: "flip-foldable", posture: "half_opened" })).toBe("compact|tabletop");
    // Turned to landscape, the flip's hinge runs top to bottom, as Android reports it.
    expect(
      label({ frame: "flip-foldable", posture: "half_opened", orientation: "landscape" }),
    ).toBe("expanded|book");
  });

  test("closed renders the cover panel; the frame names its posture", () => {
    const still = renderPrototypeStill(probe, { frame: "flip-foldable", posture: "closed" });
    expect(still.posture).toBe("closed");
    expect(chrome(still.element, "screen")[0]?.style).toMatchObject({
      width: "262px",
      height: "272px",
    });
    expect(still.element.attrs).toMatchObject({
      "data-posture": "closed",
      "aria-label": "Flip foldable (portrait, closed)",
    });
    expect(renderPrototypeStill(probe, { frame: "pixel-9" }).posture).toBeUndefined();
  });

  test("a half-opened seamless fold draws a crease at the hinge; flat and closed draw none", () => {
    const fold = (posture: string) =>
      chrome(renderPrototypeStill(probe, { frame: "pixel-fold", posture }).element, "fold");
    const [crease] = fold("half_opened");
    expect(crease?.attrs["data-hinge-degrees"]).toBe("90");
    expect(crease?.style).toMatchObject({ left: "408.5px", width: "24px" });
    expect(fold("opened")).toHaveLength(0);
    expect(fold("closed")).toHaveLength(0);
  });

  test("an occluding hinge splits one reduced layout around an opaque strip", () => {
    const view = frameInPosture(occludingFold(), "opened");
    const frame = renderDeviceFrame(
      view.frame,
      "portrait",
      {
        dark: false,
        textColor: "#000",
        background: "#fff",
        posture: "opened",
        fold: webFold(view, "portrait")!,
      },
      el("div", { attrs: { "data-testid": "content" } }),
    );
    expect(chrome(frame, "hinge")[0]?.style).toMatchObject({ left: "410px", width: "20px" });
    const segments = findAll(frame, (element) => element.attrs["data-segment"] !== undefined);
    expect(segments.map((segment) => [segment.style.left, segment.style.width])).toEqual([
      ["0px", "410px"],
      ["430px", "411px"],
    ]);
    // The second copy is shifted so the layout continues past the hinge, and is inert.
    expect(segments[1]?.attrs).toMatchObject({ "aria-hidden": "true", inert: "" });
    const boxes = segments.map((segment) => segment.children[0] as WebElement);
    expect(boxes.map((box) => [box.style.left, box.style.width])).toEqual([
      ["0px", "821px"],
      ["-410px", "821px"],
    ]);
  });

  for (const id of ["pixel-fold", "flip-foldable"]) {
    for (const posture of ["closed", "half_opened", "opened"]) {
      test(`snapshot: ${id} ${posture} in portrait`, () => {
        expect(
          toHtml(renderPrototypeStill(reference, { frame: id, posture }).element),
        ).toMatchSnapshot();
      });
    }
  }
});
