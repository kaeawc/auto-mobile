import { Image } from "../../src/utils/image/ImageTransformer";
import { loadJimp } from "../../src/utils/image/loadJimp";
import { ScreenshotComparator } from "../../src/utils/screenshot/ScreenshotComparator";
import { PerceptualHasher } from "../../src/utils/screenshot/PerceptualHasher";

const Jimp = await loadJimp();
const input = await new Jimp({ width: 4, height: 4, color: 0x285a8cff }).getBuffer("image/png");

const metadata = await Image.fromBuffer(input).getMetadata();
if (metadata.width !== 4 || metadata.height !== 4 || metadata.format !== "png") {
  throw new Error(`Unexpected image metadata: ${JSON.stringify(metadata)}`);
}

const transformed = await Image.fromBuffer(input)
  .resize(2, 2, false)
  .png()
  .toBuffer();

// WebP is the primary screenshot output format — verify encode and decode roundtrip
const webpBuffer = await Image.fromBuffer(input).webp({ quality: 65 }).toBuffer();
if (webpBuffer.subarray(0, 4).toString() !== "RIFF" || webpBuffer.subarray(8, 12).toString() !== "WEBP") {
  throw new Error("WebP encode did not produce a RIFF/WEBP container");
}
const webpMetadata = await Image.fromBuffer(webpBuffer).getMetadata();
if (webpMetadata.width !== 4 || webpMetadata.height !== 4 || webpMetadata.format !== "webp") {
  throw new Error(`Unexpected webp metadata: ${JSON.stringify(webpMetadata)}`);
}

const resized = await ScreenshotComparator.resizeImageIfNeeded(transformed, 8, 8);
const hash = await PerceptualHasher.generatePerceptualHash(resized);

if (hash.length !== 64) {
  throw new Error(`Unexpected perceptual hash length: ${hash.length}`);
}

console.log("Image runtime smoke passed");
