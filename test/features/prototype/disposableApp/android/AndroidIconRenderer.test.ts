import { beforeAll, expect, test } from "bun:test";
import {
  DefaultAndroidIconRenderer,
  MAX_ICON_ASSET_PIXELS,
} from "../../../../../src/features/prototype/disposableApp/android/AndroidIconRenderer";
import { JimpBackend } from "../../../../../src/utils/image/backend/JimpBackend";
import { loadJimp } from "../../../../../src/utils/image/loadJimp";

const renderer = new DefaultAndroidIconRenderer();
const backend = new JimpBackend();
const dark = { r: 15, g: 20, b: 25, a: 1 };
let png: Buffer;
let jpeg: Buffer;
let square: Buffer;

beforeAll(async () => {
  const Jimp = await loadJimp();
  const source = new Jimp({ width: 4, height: 2, color: 0x3164a580 });
  png = await source.getBuffer("image/png");
  square = await new Jimp({ width: 2, height: 2, color: 0x3164a5ff }).getBuffer("image/png");
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
  // 4x2 artwork scales by its diagonal to 236x118, centred at (98, 157).
  expect(fg.data.readUInt32BE(offset(98, 157))).toBe(0x3164a580);
  expect(fg.data.readUInt32BE(offset(333, 274))).toBe(0x3164a580);
  expect(fg.data.readUInt32BE(offset(97, 157))).toBe(0);
  expect(fg.data.readUInt32BE(offset(98, 156))).toBe(0);
  expect(fg.data.readUInt32BE(offset(334, 275))).toBe(0);
  expect(mono.data.readUInt32BE(offset(98, 157))).toBe(0x00000080);
  expect(mono.data.readUInt32BE(offset(97, 157))).toBe(0);
});

test("keeps every corner of square artwork inside the 264px circular safe zone", async () => {
  const fg = await backend.rawPixels((await renderer.render({ bytes: square })).foreground);
  const alpha = (x: number, y: number) => fg.data[(y * fg.width + x) * 4 + 3];
  expect([alpha(123, 123), alpha(308, 123), alpha(123, 308), alpha(308, 308)]).toEqual([
    255, 255, 255, 255,
  ]);
  expect([alpha(122, 123), alpha(309, 308)]).toEqual([0, 0]);
  for (const [x, y] of [
    [123, 123],
    [308, 308],
  ] as const) {
    expect(Math.hypot(x + 0.5 - 216, y + 0.5 - 216)).toBeLessThanOrEqual(132);
  }
});

test("rejects artwork whose header declares too many pixels before decoding it", async () => {
  const oversized = Buffer.from(square);
  oversized.writeUInt32BE(16384, 16);
  oversized.writeUInt32BE(16384, 20);
  expect(16384 * 16384).toBeGreaterThan(MAX_ICON_ASSET_PIXELS);
  let decoded = false;
  const guarded = new DefaultAndroidIconRenderer({
    rawPixels: async () => {
      decoded = true;
      throw new Error("decoded");
    },
  });
  await expect(guarded.render({ bytes: oversized })).rejects.toThrow(/at most 16777216 pixels/);
  expect(decoded).toBe(false);
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
