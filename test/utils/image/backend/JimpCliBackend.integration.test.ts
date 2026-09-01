import { describe, expect, test } from "bun:test";
import type { CliWebpEncodeOptions } from "../../../../src/utils/image/webp/CliWebpCodec";
import type { ImagePipeline } from "../../../../src/utils/image/backend/ImageBackend";
import { JimpCliBackend, type WebpCodec } from "../../../../src/utils/image/backend/JimpCliBackend";

class FakeWebpCodec implements WebpCodec {
  public readonly encodeCalls: Array<{ input: Buffer; options: CliWebpEncodeOptions }> = [];
  public readonly decodeCalls: Buffer[] = [];

  constructor(
    private readonly decodedPng: Buffer,
    private readonly encodedWebp: Buffer = Buffer.from("RIFFxxxxWEBPencoded"),
  ) {}

  async encode(input: Buffer, options: CliWebpEncodeOptions = {}): Promise<Buffer> {
    this.encodeCalls.push({ input, options });
    return this.encodedWebp;
  }

  async decode(input: Buffer): Promise<Buffer> {
    this.decodeCalls.push(input);
    return this.decodedPng;
  }
}

async function makeSourcePng(width = 8, height = 8): Promise<Buffer> {
  const { Jimp, rgbaToInt } = await import("jimp");
  const image = new Jimp({ width, height, color: 0x000000ff });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image.setPixelColor(rgbaToInt((x * 16) % 256, (y * 16) % 256, (x * y) % 256, 255), x, y);
    }
  }
  return image.getBuffer("image/png");
}

const WEBP_SOURCE = Buffer.from("RIFFxxxxWEBPsource");

describe("JimpCliBackend", () => {
  test("encodes WebP output through CliWebpCodec after jimp applies the pipeline", async () => {
    const source = await makeSourcePng(8, 8);
    const codec = new FakeWebpCodec(source);
    const backend = new JimpCliBackend({ webpCodec: codec });
    const pipeline: ImagePipeline = {
      operations: [{ type: "resize", width: 4, height: 2, maintainAspectRatio: false }],
      encoding: { mime: "image/webp", options: { quality: 60 } },
    };

    const out = await backend.execute(source, pipeline);

    expect(out.toString()).toBe("RIFFxxxxWEBPencoded");
    expect(codec.encodeCalls).toHaveLength(1);
    expect(codec.encodeCalls[0].options).toEqual({ quality: 60 });
    const intermediateMeta = await backend.metadata(codec.encodeCalls[0].input);
    expect(intermediateMeta).toMatchObject({ width: 4, height: 2, format: "png" });
    expect(codec.decodeCalls).toHaveLength(0);
  });

  test("decodes WebP input through CliWebpCodec before metadata and raw pixel reads", async () => {
    const decodedPng = await makeSourcePng(3, 2);
    const codec = new FakeWebpCodec(decodedPng);
    const backend = new JimpCliBackend({ webpCodec: codec });

    const meta = await backend.metadata(WEBP_SOURCE);
    const raw = await backend.rawPixels(WEBP_SOURCE);

    expect(meta).toEqual({ width: 3, height: 2, format: "webp", size: WEBP_SOURCE.length });
    expect(raw.width).toBe(3);
    expect(raw.height).toBe(2);
    expect(raw.data.length).toBe(3 * 2 * 4);
    expect(codec.decodeCalls).toEqual([WEBP_SOURCE, WEBP_SOURCE]);
  });

  test("decodes WebP input and re-encodes WebP when no output encoding is requested", async () => {
    const decodedPng = await makeSourcePng(6, 4);
    const codec = new FakeWebpCodec(decodedPng);
    const backend = new JimpCliBackend({ webpCodec: codec });
    const pipeline: ImagePipeline = {
      operations: [{ type: "resize", width: 3, maintainAspectRatio: true }],
      encoding: null,
    };

    const out = await backend.execute(WEBP_SOURCE, pipeline);

    expect(out.toString()).toBe("RIFFxxxxWEBPencoded");
    expect(codec.decodeCalls).toEqual([WEBP_SOURCE]);
    expect(codec.encodeCalls).toHaveLength(1);
    const intermediateMeta = await backend.metadata(codec.encodeCalls[0].input);
    expect(intermediateMeta).toMatchObject({ width: 3, height: 2, format: "png" });
  });

  test("passes lossless and near-lossless WebP intent to CliWebpCodec unchanged", async () => {
    const source = await makeSourcePng();
    const codec = new FakeWebpCodec(source);
    const backend = new JimpCliBackend({ webpCodec: codec });

    await backend.execute(source, {
      operations: [],
      encoding: { mime: "image/webp", options: { lossless: true, quality: 90 } },
    });
    await backend.execute(source, {
      operations: [],
      encoding: { mime: "image/webp", options: { nearLossless: true, quality: 40 } },
    });

    expect(codec.encodeCalls.map((call) => call.options)).toEqual([
      { lossless: true, quality: 90 },
      { nearLossless: true, quality: 40 },
    ]);
  });
});
