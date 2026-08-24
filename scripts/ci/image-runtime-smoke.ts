import { Image } from "../../src/utils/image/ImageTransformer";
import { loadJimp } from "../../src/utils/image/loadJimp";
import { ScreenshotComparator } from "../../src/utils/screenshot/ScreenshotComparator";
import { PerceptualHasher } from "../../src/utils/screenshot/PerceptualHasher";

const Jimp = await loadJimp();

// Build a non-uniform image: solid-colour fixtures survive any resize kernel or
// WebP mode identically and would mask real regressions, so use a gradient.
const { rgbaToInt } = await import("jimp");
const source = new Jimp({ width: 64, height: 64, color: 0x000000ff });
for (let y = 0; y < 64; y++) {
  for (let x = 0; x < 64; x++) {
    source.setPixelColor(rgbaToInt((x * 4) % 256, (y * 4) % 256, (x * y) % 256, 255), x, y);
  }
}
const input = await source.getBuffer("image/png");

const metadata = await Image.fromBuffer(input).getMetadata();
if (metadata.width !== 64 || metadata.height !== 64 || metadata.format !== "png") {
  throw new Error(`Unexpected image metadata: ${JSON.stringify(metadata)}`);
}

const transformed = await Image.fromBuffer(input).resize(2, 2, false).png().toBuffer();

// WebP is the primary screenshot output format — verify encode/decode roundtrip
// AND that the three encode modes are actually distinct. A silently-dropped
// option key (e.g. wrong casing) would collapse near-lossless onto lossless.
const lossy = await Image.fromBuffer(input).webp({ quality: 60 }).toBuffer();
const lossless = await Image.fromBuffer(input).webp({ lossless: true }).toBuffer();
const nearLossless = await Image.fromBuffer(input)
  .webp({ nearLossless: true, quality: 40 })
  .toBuffer();

for (const [name, buf] of [
  ["lossy", lossy],
  ["lossless", lossless],
  ["nearLossless", nearLossless],
] as const) {
  if (buf.subarray(0, 4).toString() !== "RIFF" || buf.subarray(8, 12).toString() !== "WEBP") {
    throw new Error(`WebP ${name} encode did not produce a RIFF/WEBP container`);
  }
}
if (nearLossless.length === lossless.length) {
  throw new Error(
    "WebP nearLossless produced byte-identical output to lossless — option was dropped",
  );
}

const webpMetadata = await Image.fromBuffer(lossy).getMetadata();
if (webpMetadata.width !== 64 || webpMetadata.height !== 64 || webpMetadata.format !== "webp") {
  throw new Error(`Unexpected webp metadata: ${JSON.stringify(webpMetadata)}`);
}

const resized = await ScreenshotComparator.resizeImageIfNeeded(transformed, 8, 8);
const hash = await PerceptualHasher.generatePerceptualHash(resized);

if (hash.length !== 64) {
  throw new Error(`Unexpected perceptual hash length: ${hash.length}`);
}
// A gradient must not collapse to an all-zero/all-one hash — that would signal a
// broken greyscale/raw-pixel path (e.g. wrong channel stride).
if (/^0+$/.test(hash) || /^1+$/.test(hash)) {
  throw new Error(`Perceptual hash is degenerate (all same bit): ${hash}`);
}

console.log("Image runtime smoke passed");
