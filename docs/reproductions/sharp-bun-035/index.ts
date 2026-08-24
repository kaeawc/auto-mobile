import sharp from "sharp";

const runtime = {
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  sharp: sharp.versions,
};

console.log("runtime", JSON.stringify(runtime, null, 2));

const source = await sharp({
  create: {
    width: 32,
    height: 32,
    channels: 4,
    background: { r: 16, g: 96, b: 192, alpha: 1 },
  },
})
  .png()
  .toBuffer();

const lossyWebp = await sharp(source).resize(16, 16).webp({ quality: 60 }).toBuffer();

const losslessWebp = await sharp(source).webp({ lossless: true }).toBuffer();

const nearLosslessWebp = await sharp(source).webp({ nearLossless: true, quality: 40 }).toBuffer();

const metadata = await sharp(lossyWebp).metadata();

console.log("metadata", JSON.stringify(metadata, null, 2));
console.log(
  "webpSizes",
  JSON.stringify(
    {
      lossy: lossyWebp.length,
      lossless: losslessWebp.length,
      nearLossless: nearLosslessWebp.length,
    },
    null,
    2,
  ),
);
console.log("ok");
