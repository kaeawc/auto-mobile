import { beforeAll, expect, test } from "bun:test";
import { DefaultAndroidIconRenderer } from "../../../../../src/features/prototype/disposableApp/android/AndroidIconRenderer";
import { JimpBackend } from "../../../../../src/utils/image/backend/JimpBackend";
import { loadJimp } from "../../../../../src/utils/image/loadJimp";

const renderer = new DefaultAndroidIconRenderer();
const backend = new JimpBackend();
const dark = { r: 15, g: 20, b: 25, a: 1 };
let png: Buffer;
let jpeg: Buffer;

beforeAll(async () => {
  const Jimp = await loadJimp();
  const source = new Jimp({ width: 4, height: 2, color: 0x3164a580 });
  png = await source.getBuffer("image/png");
  jpeg = await new Jimp({ width: 4, height: 2, color: 0x3164a5ff }).getBuffer("image/jpeg");
  // Load the bitmap font and image codecs outside the measured test body.
  await renderer.render({ label: "F", background: dark });
});

test("fits a translucent rectangular asset inside the safe zone and preserves its alpha", async () => {
  const layers = await renderer.render({ bytes: png });
  const fg = await backend.rawPixels(layers.foreground);
  const mono = await backend.rawPixels(layers.monochrome);
  expect([fg.width, fg.height, mono.width, mono.height]).toEqual([432, 432, 432, 432]);
  const offset = (x: number, y: number) => (y * fg.width + x) * 4;
  expect(fg.data.readUInt32BE(offset(72, 144))).toBe(0x3164a580);
  expect(fg.data.readUInt32BE(offset(359, 287))).toBe(0x3164a580);
  expect(fg.data.readUInt32BE(offset(71, 144))).toBe(0);
  expect(fg.data.readUInt32BE(offset(72, 143))).toBe(0);
  expect(fg.data.readUInt32BE(offset(360, 288))).toBe(0);
  expect(mono.data.readUInt32BE(offset(72, 144))).toBe(0x00000080);
  expect(mono.data.readUInt32BE(offset(71, 144))).toBe(0);
});

test("accepts JPEG artwork", async () => {
  const { monochrome } = await renderer.render({ bytes: jpeg });
  const { data, width } = await backend.rawPixels(monochrome);
  expect(data.readUInt32BE((width * 216 + 216) * 4)).toBe(0x000000ff);
});

test("the first grapheme produces a contrasting glyph with the same monochrome silhouette", async () => {
  const { foreground, monochrome } = await renderer.render({
    label: "e\u0301clair",
    background: dark,
  });
  const fg = await backend.rawPixels(foreground);
  const mono = await backend.rawPixels(monochrome);
  const solid = fg.data.findIndex((byte, index) => index % 4 === 3 && byte === 255);
  expect(solid).toBeGreaterThan(0);
  expect(fg.data.readUInt32BE(solid - 3)).toBe(0xffffffff);
  expect(mono.data.readUInt32BE(solid - 3)).toBe(0x000000ff);
  expect(fg.data.every((byte, index) => index % 4 !== 3 || byte === mono.data[index])).toBe(true);
});

test("uppercases the initial grapheme and uses black ink on a light background", async () => {
  const background = { r: 255, g: 245, b: 235, a: 1 };
  const lower = await renderer.render({ label: "e\u0301clair", background });
  const upper = await renderer.render({ label: "Étagère", background });
  expect(lower.foreground.equals(upper.foreground)).toBe(true);
  expect(lower.foreground.equals(lower.monochrome)).toBe(true);
});
