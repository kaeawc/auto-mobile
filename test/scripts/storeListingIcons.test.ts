import { describe, expect, test } from "bun:test";
import {
  allIconTargets,
  androidTargets,
  iosContentsJson,
  iosTargets,
  type IconTarget,
} from "../../scripts/store-listing/iconTargets";
import {
  parseArgs,
  renderIcons,
  type IconRenderer,
} from "../../scripts/store-listing/generate-icons";

const sources = { background: "<svg/>", foreground: "<svg/>" };

describe("icon targets", () => {
  const sizeOf = (path: string) => allIconTargets().find((target) => target.path === path)?.size;

  test("Android adaptive layers scale 108 dp and legacy icons 48 dp across densities", () => {
    expect(sizeOf("android/mipmap-mdpi/ic_launcher_foreground.png")).toBe(108);
    expect(sizeOf("android/mipmap-hdpi/ic_launcher_foreground.png")).toBe(162);
    expect(sizeOf("android/mipmap-xxxhdpi/ic_launcher_foreground.png")).toBe(432);
    expect(sizeOf("android/mipmap-mdpi/ic_launcher.png")).toBe(48);
    expect(sizeOf("android/mipmap-xxxhdpi/ic_launcher.png")).toBe(192);
  });

  test("every density has foreground, background, monochrome and legacy rasters", () => {
    const layers = androidTargets()
      .filter((target) => target.path.includes("mipmap-xhdpi"))
      .map((target) => target.layer)
      .sort();
    expect(layers).toEqual(["background", "composite", "foreground", "monochrome"]);
  });

  test("the Play icon is 512 and the iOS marketing icons are 1024, opaque, in three appearances", () => {
    expect(sizeOf("android/play-store/icon.png")).toBe(512);
    expect(iosTargets().map((target) => [target.appearance, target.size, target.opaque])).toEqual([
      ["any", 1024, true],
      ["dark", 1024, true],
      ["tinted", 1024, true],
    ]);
  });

  test("target paths are unique", () => {
    const paths = allIconTargets().map((target) => target.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("the asset catalog manifest names every iOS raster", () => {
    const contents = JSON.parse(iosContentsJson()) as {
      images: { filename: string; appearances?: { value: string }[] }[];
    };
    const files = iosTargets().map((target) => target.path.split("/").pop() ?? "");
    expect(contents.images.map((image) => image.filename)).toEqual(files);
    expect(contents.images.map((image) => image.appearances?.[0]?.value ?? "light")).toEqual([
      "light",
      "dark",
      "tinted",
    ]);
  });
});

describe("renderIcons", () => {
  test("renders every target in table order and appends the catalog manifest", async () => {
    const seen: IconTarget[] = [];
    const renderer: IconRenderer = {
      async render(target) {
        seen.push(target);
        return new Uint8Array([target.size % 256]);
      },
    };
    const rendered = await renderIcons(renderer, sources);
    expect(seen).toEqual(allIconTargets());
    expect(rendered.map((icon) => icon.path)).toEqual([
      ...allIconTargets().map((target) => target.path),
      "ios/AppIcon.appiconset/Contents.json",
    ]);
  });

  test("two runs over the same sources produce identical output", async () => {
    const renderer: IconRenderer = {
      async render(target, input) {
        return new TextEncoder().encode(`${target.path}:${input.foreground}`);
      },
    };
    expect(await renderIcons(renderer, sources)).toEqual(await renderIcons(renderer, sources));
  });
});

describe("generate-icons arguments", () => {
  test("parses --out and --list", () => {
    expect(parseArgs(["--out", "x"])).toEqual({ out: "x", list: false });
    expect(parseArgs(["--list"])).toEqual({ out: undefined, list: true });
  });
});
