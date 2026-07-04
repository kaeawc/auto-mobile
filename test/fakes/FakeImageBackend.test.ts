import { describe, expect, test, beforeEach } from "bun:test";
import { FakeImageBackend } from "./FakeImageBackend";
import type { ImagePipeline } from "../../src/utils/image/backend/ImageBackend";

describe("FakeImageBackend", () => {
  let backend: FakeImageBackend;
  const source = Buffer.from("src");
  const pipeline: ImagePipeline = {
    operations: [{ type: "resize", width: 10, height: 10, maintainAspectRatio: false }],
    encoding: { mime: "image/png" }
  };

  beforeEach(() => {
    backend = new FakeImageBackend();
  });

  describe("defaults", () => {
    test("execute returns a canned buffer", async () => {
      expect((await backend.execute(source, pipeline)).length).toBeGreaterThan(0);
    });

    test("metadata returns canned metadata", async () => {
      const meta = await backend.metadata(source);
      expect(meta).toEqual({ width: 1080, height: 2400, format: "png", size: 1024000 });
    });

    test("rawPixels returns RGBA data sized width*height*4", async () => {
      const raw = await backend.rawPixels(source);
      expect(raw.width).toBe(2);
      expect(raw.height).toBe(2);
      expect(raw.data.length).toBe(2 * 2 * 4);
    });
  });

  describe("configuration", () => {
    test("setExecuteResult overrides the execute buffer", async () => {
      backend.setExecuteResult(Buffer.from([1, 2, 3]));
      expect([...(await backend.execute(source, pipeline))]).toEqual([1, 2, 3]);
    });

    test("setMetadataResult overrides metadata", async () => {
      backend.setMetadataResult({ width: 1, height: 1, format: "webp", size: 9 });
      expect((await backend.metadata(source)).format).toBe("webp");
    });

    test("setRawPixelsResult overrides raw pixels", async () => {
      backend.setRawPixelsResult({ width: 1, height: 1, data: Buffer.from([9, 9, 9, 9]) });
      expect((await backend.rawPixels(source)).width).toBe(1);
    });
  });

  describe("call tracking", () => {
    test("records execute calls with source and pipeline", async () => {
      await backend.execute(source, pipeline);
      expect(backend.executeCalls).toHaveLength(1);
      expect(backend.executeCalls[0].source).toBe(source);
      expect(backend.executeCalls[0].pipeline).toBe(pipeline);
      expect(backend.lastPipeline).toBe(pipeline);
    });

    test("records metadata and rawPixels calls", async () => {
      await backend.metadata(source);
      await backend.rawPixels(source);
      expect(backend.metadataCalls).toEqual([source]);
      expect(backend.rawPixelsCalls).toEqual([source]);
    });
  });

  describe("error injection", () => {
    test("execute throws when configured", async () => {
      backend.setShouldThrowOnExecute(true);
      await expect(backend.execute(source, pipeline)).rejects.toThrow("Simulated error in execute");
    });

    test("metadata throws when configured", async () => {
      backend.setShouldThrowOnMetadata(true);
      await expect(backend.metadata(source)).rejects.toThrow("Simulated error in metadata");
    });

    test("rawPixels throws when configured", async () => {
      backend.setShouldThrowOnRawPixels(true);
      await expect(backend.rawPixels(source)).rejects.toThrow("Simulated error in rawPixels");
    });
  });
});
