import { Image } from "../../src/utils/image/ImageTransformer";
import { loadSharp } from "../../src/utils/image/loadSharp";
import { ScreenshotComparator } from "../../src/utils/screenshot/ScreenshotComparator";
import { PerceptualHasher } from "../../src/utils/screenshot/PerceptualHasher";

const sharp = await loadSharp();
const input = await sharp({
  create: {
    width: 4,
    height: 4,
    channels: 4,
    background: { r: 40, g: 90, b: 140, alpha: 1 },
  },
})
  .png()
  .toBuffer();

const metadata = await Image.fromBuffer(input).getMetadata();
if (metadata.width !== 4 || metadata.height !== 4 || metadata.format !== "png") {
  throw new Error(`Unexpected sharp metadata: ${JSON.stringify(metadata)}`);
}

const transformed = await Image.fromBuffer(input)
  .resize(2, 2, false)
  .png()
  .toBuffer();

const resized = await ScreenshotComparator.resizeImageIfNeeded(transformed, 8, 8);
const hash = await PerceptualHasher.generatePerceptualHash(resized);

if (hash.length !== 64) {
  throw new Error(`Unexpected perceptual hash length: ${hash.length}`);
}

console.log("Sharp runtime smoke passed");
