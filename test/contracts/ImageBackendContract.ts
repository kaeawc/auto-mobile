import { describe, expect, test } from "bun:test";
import type { ImageBackend, ImagePipeline } from "../../src/utils/image/backend/ImageBackend";

/** Facts about the PNG fixture handed to the backend under test. */
export interface ImageBackendFixture {
  png: Buffer;
  width: number;
  height: number;
}

const PNG_MAGIC = "89504e47";

const passthrough: ImagePipeline = { operations: [], encoding: { mime: "image/png" } };

/**
 * Shared behavioural contract for {@link ImageBackend} (#11868): the fake and the real
 * decoders (jimp, sharp) must agree on the shape of metadata and raw pixels, on never aliasing
 * caller-visible buffers, and on rejecting an empty source. The fixture is a captured PNG already
 * in the repository; the fake is scripted from its facts, the real backends decode it.
 */
export const runImageBackendContract = (
  description: string,
  makeBackend: (fixture: ImageBackendFixture) => ImageBackend,
  fixture: ImageBackendFixture,
): void => {
  describe(`ImageBackend contract: ${description}`, function () {
    test("metadata reports the fixture dimensions, png format and source byte size", async () => {
      const meta = await makeBackend(fixture).metadata(fixture.png);

      expect(meta.width).toBe(fixture.width);
      expect(meta.height).toBe(fixture.height);
      expect(meta.format).toBe("png");
      expect(meta.size).toBe(fixture.png.length);
    });

    test("metadata returns a fresh object each call", async () => {
      const backend = makeBackend(fixture);
      const first = await backend.metadata(fixture.png);
      first.width = -1;

      expect((await backend.metadata(fixture.png)).width).toBe(fixture.width);
    });

    test("rawPixels is RGBA sized width*height*4 and agrees with metadata", async () => {
      const backend = makeBackend(fixture);
      const raw = await backend.rawPixels(fixture.png);
      const meta = await backend.metadata(fixture.png);

      expect(raw.width).toBe(meta.width);
      expect(raw.height).toBe(meta.height);
      expect(raw.data.length).toBe(raw.width * raw.height * 4);
    });

    test("rawPixels returns a copy callers may mutate", async () => {
      const backend = makeBackend(fixture);
      const first = await backend.rawPixels(fixture.png);
      const original = first.data[0];
      first.data[0] = (original + 1) % 256;

      const second = await backend.rawPixels(fixture.png);

      expect(second.data).not.toBe(first.data);
      expect(second.data[0]).toBe(original);
    });

    test("execute returns a png buffer that is not the source and leaves the source intact", async () => {
      const backend = makeBackend(fixture);
      const before = Buffer.from(fixture.png);

      const out = await backend.execute(fixture.png, passthrough);

      expect(out).not.toBe(fixture.png);
      expect(out.subarray(0, 4).toString("hex")).toBe(PNG_MAGIC);
      expect(fixture.png.equals(before)).toBe(true);
    });

    test("execute returns a buffer callers may mutate", async () => {
      const backend = makeBackend(fixture);
      const first = await backend.execute(fixture.png, passthrough);
      const original = first[0];
      first[0] = (original + 1) % 256;

      expect((await backend.execute(fixture.png, passthrough))[0]).toBe(original);
    });

    test("an empty source rejects from every operation", async () => {
      const backend = makeBackend(fixture);
      const empty = Buffer.alloc(0);

      await expect(backend.metadata(empty)).rejects.toThrow();
      await expect(backend.rawPixels(empty)).rejects.toThrow();
      await expect(backend.execute(empty, passthrough)).rejects.toThrow();
    });
  });
};
