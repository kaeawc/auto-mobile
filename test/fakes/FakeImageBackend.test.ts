import { describe, expect, test, beforeEach } from "bun:test";
import { FakeImageBackend } from "./FakeImageBackend";
import type { ImagePipeline } from "../../src/utils/image/backend/ImageBackend";

describe("FakeImageBackend", () => {
  let backend: FakeImageBackend;
  const source = Buffer.from("src");
  const pipeline: ImagePipeline = {
    operations: [{ type: "resize", width: 10, height: 10, maintainAspectRatio: false }],
    encoding: { mime: "image/png" },
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

    test("rawPixels returns a defensive copy of canned pixels", async () => {
      const first = await backend.rawPixels(source);
      first.data[0] = 1;

      const second = await backend.rawPixels(source);

      expect(second).not.toBe(first);
      expect(second.data).not.toBe(first.data);
      expect(second.data[0]).toBe(255);
    });

    test("execute returns a defensive copy of the canned buffer", async () => {
      backend.setExecuteResult(Buffer.from([10, 20, 30]));
      const first = await backend.execute(source, pipeline);
      first[0] = 99;

      const second = await backend.execute(source, pipeline);

      // Mutating a returned buffer must not corrupt the stored result — the same
      // reference-vs-copy asymmetry rawPixels already guards against.
      expect(second).not.toBe(first);
      expect([...second]).toEqual([10, 20, 30]);
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
    type Method = "execute" | "metadata" | "rawPixels";
    const invoke = (b: FakeImageBackend, method: Method): Promise<unknown> =>
      method === "execute" ? b.execute(source, pipeline) : b[method](source);
    const arm = (b: FakeImageBackend, method: Method, on: boolean): void => {
      if (method === "execute") {
        b.setShouldThrowOnExecute(on);
      } else if (method === "metadata") {
        b.setShouldThrowOnMetadata(on);
      } else {
        b.setShouldThrowOnRawPixels(on);
      }
    };
    const methods: Method[] = ["execute", "metadata", "rawPixels"];

    test.each(methods)("%s throws only when its own injection is armed", async (method) => {
      arm(backend, method, true);
      await expect(invoke(backend, method)).rejects.toThrow(`Simulated error in ${method}`);
    });

    test.each(methods)("%s stops throwing once its injection is disarmed", async (method) => {
      arm(backend, method, true);
      arm(backend, method, false);
      await expect(invoke(backend, method)).resolves.toBeDefined();
    });

    test.each([
      ["execute", "metadata"],
      ["execute", "rawPixels"],
      ["metadata", "rawPixels"],
    ] as Array<[Method, Method]>)("arming %s does not make %s throw", async (armed, other) => {
      arm(backend, armed, true);
      await expect(invoke(backend, other)).resolves.toBeDefined();
    });
  });
});
