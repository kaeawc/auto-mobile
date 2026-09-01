import { describe, expect, test } from "bun:test";
import { resolveImageBackend } from "../../../../src/utils/image/backend/resolveImageBackend";
import { SharpBackend } from "../../../../src/utils/image/backend/SharpBackend";

describe("resolveImageBackend fallback", () => {
  test("falls back to JimpBackend behavior when sharp discovery fails", async () => {
    const { Jimp, rgbaToInt } = await import("jimp");
    const source = await new Jimp({
      width: 2,
      height: 2,
      color: rgbaToInt(1, 2, 3, 255),
    }).getBuffer("image/png");
    const backend = resolveImageBackend({
      platform: "linux",
      sharpLoader: async () => {
        throw new Error("sharp unavailable");
      },
    });

    expect(backend).toBeInstanceOf(SharpBackend);
    await expect(backend.metadata(source)).resolves.toMatchObject({
      width: 2,
      height: 2,
      format: "png",
    });
  });
});
