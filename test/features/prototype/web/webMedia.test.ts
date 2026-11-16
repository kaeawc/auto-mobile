import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mediaTime } from "../../../../src/features/prototype/web/webMedia";
import {
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

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}
const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

function still(root: Record<string, unknown>, frame: "pixel-9" | "iphone-16" = "pixel-9") {
  const rendered = renderPrototypeStill({ ...reference, root }, { frame });
  const part = (name: string) =>
    find(rendered.element, (element) => element.attrs["data-part"] === name);
  const node = (type: string) =>
    find(rendered.element, (element) => element.attrs["data-node"] === type);
  return { ...rendered, part, node, html: toHtml(rendered.element) };
}

describe("prototype web media nodes (#16539)", () => {
  test("mediaTime labels a position as m:ss", () => {
    expect(mediaTime(0)).toBe("0:00");
    expect(mediaTime(65_400)).toBe("1:05");
  });

  test("a video player draws its frame and the Android chrome, not a placeholder", () => {
    const video = still({
      type: "videoPlayer",
      id: "clip",
      source: { sample: "colorBars" },
      startMs: 12_000,
      captions: [{ id: "en", language: "en", label: "English", source: { data: "/cues" } }],
    });
    expect(video.unsupportedNodes).toEqual([]);
    expect(video.node("videoPlayer")[0]!.attrs.role).toBe("region");
    expect(video.part("frame")[0]!.style.background).toContain("linear-gradient");
    expect(video.part("play")).toHaveLength(1);
    expect(textOf(video.part("time")[0]!)).toBe("0:12");
    expect(video.part("captions")[0]!.attrs["aria-label"]).toBe("Captions: English");
  });

  test("the iOS skin puts play in the control bar, and controls none draws no chrome", () => {
    const ios = still(
      { type: "videoPlayer", source: { url: "https://example.com/a.mp4" } },
      "iphone-16",
    );
    expect(ios.part("play")).toHaveLength(0);
    expect(ios.part("controls")[0]!.style["border-radius"]).toBe("12px");
    const bare = still({ type: "videoPlayer", player: "main", controls: "none" });
    expect(bare.part("controls")).toHaveLength(0);
    expect(bare.part("play")).toHaveLength(0);
  });

  test("a declared player's sample source draws its frame", () => {
    const rendered = renderPrototypeStill(
      {
        ...reference,
        media: { players: { main: { kind: "video", source: { sample: "colorBars" } } } },
        root: { type: "videoPlayer", player: "main" },
      },
      { frame: "pixel-9" },
    );
    const frame = find(rendered.element, (element) => element.attrs["data-part"] === "frame");
    expect(frame[0]!.style.background).toContain("linear-gradient");
  });

  test("a poster asset without bytes is listed as not inlined and draws no poster", () => {
    const video = still({ type: "videoPlayer", id: "clip", player: "main", poster: "p" });
    expect(video.unsupportedNodes).toEqual([
      { type: "videoPlayer", id: "clip", path: "root", reason: "assetNotInlined", asset: "p" },
    ]);
    expect(video.part("poster")).toEqual([]);
    expect(video.imageDraws).toMatchObject([{ asset: "p", scale: "fit" }]);
  });

  test("a sized player encodes its poster at the player's size, not the screen's", () => {
    const fixed = still({
      type: "videoPlayer",
      poster: "p",
      style: { width: { dp: 80 }, height: { dp: 45 } },
    });
    expect(fixed.imageDraws).toMatchObject([
      { asset: "p", widthDp: 80, heightDp: 45, scale: "fit" },
    ]);
    // A fixed width alone bounds the height by the player's 16:9.
    const wide = still({ type: "videoPlayer", poster: "p", style: { width: { dp: 160 } } });
    expect(wide.imageDraws).toMatchObject([
      { asset: "p", widthDp: 160, heightDp: 90, scale: "fit" },
    ]);
  });

  test("a poster with a slot fits the player over black once its rule is inlined (#16591)", () => {
    const rendered = renderPrototypeStill(
      { ...reference, root: { type: "videoPlayer", id: "clip", poster: "p" } },
      { frame: "pixel-9", imageSlots: new Map([["p", 2]]) },
    );
    expect(rendered.unsupportedNodes).toEqual([
      { type: "videoPlayer", id: "clip", path: "root", reason: "assetOverBudget", asset: "p" },
    ]);
    const [poster] = find(rendered.element, (element) => element.attrs["data-part"] === "poster");
    expect(poster!.style["background-color"]).toBe("rgba(0,0,0,var(--pa-2-on,0))");
    const [layer] = find(poster!, (element) => element.attrs["data-image"] === "");
    expect(layer!.style["background-image"]).toBe("var(--pa-2)");
    expect(layer!.style["background-size"]).toBe("contain");
  });

  test("a poster sits over the first frame and under the chrome", () => {
    const rendered = renderPrototypeStill(
      { ...reference, root: { type: "videoPlayer", poster: "p", source: { sample: "colorBars" } } },
      { frame: "pixel-9", imageSlots: new Map([["p", 0]]) },
    );
    const [player] = find(rendered.element, (e) => e.attrs["data-node"] === "videoPlayer");
    const parts = player!.children.flatMap((child) =>
      typeof child === "string" ? [] : [child.attrs["data-part"] ?? ""],
    );
    expect(parts.slice(0, 2)).toEqual(["frame", "poster"]);
  });

  test("a camera preview draws a labelled test pattern at its aspect ratio", () => {
    const camera = still({ type: "cameraPreview", id: "cam", aspectRatio: "16:9", mode: "video" });
    expect(camera.unsupportedNodes).toEqual([]);
    expect(camera.node("cameraPreview")[0]!.style["aspect-ratio"]).toBe("9 / 16");
    expect(camera.part("test-pattern")).toHaveLength(1);
    expect(textOf(camera.part("label")[0]!)).toBe("Camera preview · video");
  });

  test("a cast button is the skin's route icon opening an empty device picker", () => {
    const android = still({ type: "castButton", player: "main" });
    expect(android.unsupportedNodes).toEqual([]);
    expect(android.node("castButton")[0]!.tag).toBe("details");
    expect(android.html).toContain('<summary aria-label="Cast"');
    expect(textOf(android.part("device-picker")[0]!)).toBe("Cast toNo devices found");
    const ios = still({ type: "castButton", player: "main" }, "iphone-16");
    expect(ios.html).toContain('<summary aria-label="AirPlay"');
  });

  test("no media node references an external URL", () => {
    const html = still({
      type: "column",
      children: [
        { type: "videoPlayer", source: { url: "https://example.com/a.mp4" } },
        { type: "cameraPreview" },
        { type: "castButton", player: "main" },
      ],
    }).html;
    expect(html).not.toContain("example.com");
    expect(html).not.toMatch(/\b(src|href)=/);
  });
});
