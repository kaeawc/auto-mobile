import { beforeAll, expect, test } from "bun:test";
import { PNG } from "pngjs";
import { IosPrototypeIconRenderer } from "../../../../src/features/prototype/ios/iosPrototypeIconRenderer";
import { loadJimp } from "../../../../src/utils/image/loadJimp";
import { FakeImageBackend } from "../../../fakes/FakeImageBackend";

beforeAll(async () => {
  // Load the existing image library outside per-test timing; rendering itself remains measured.
  await loadJimp();
});

for (const sizePx of [120, 180]) {
  test(`image icons use cover resize and PNG encoding at ${sizePx}`, async () => {
    const backend = new FakeImageBackend();
    const image = Buffer.from("uploaded image");
    await new IosPrototypeIconRenderer(backend).render({ image }, sizePx);
    expect(backend.executeCalls).toEqual([
      {
        source: image,
        pipeline: {
          operations: [
            { type: "resize", width: sizePx, height: sizePx, maintainAspectRatio: true },
          ],
          encoding: { mime: "image/png" },
        },
      },
    ]);
  });
}

test("real jimp renders a fully opaque full-bleed default blue square PNG", async () => {
  const png = await new IosPrototypeIconRenderer().render({}, 8);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(8);
  expect(png.readUInt32BE(20)).toBe(8);
  const image = PNG.sync.read(png);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    expect([...image.data.subarray(offset, offset + 4)]).toEqual([46, 89, 191, 255]);
  }
});

test("real jimp uses the authored background color", async () => {
  const authored = PNG.sync.read(
    await new IosPrototypeIconRenderer().render({ backgroundColor: "#AABBCC" }, 8),
  );
  const authoredCenter = (4 * 8 + 4) * 4;
  expect([...authored.data.subarray(authoredCenter, authoredCenter + 4)]).toEqual([
    170, 187, 204, 255,
  ]);
});

test("rejects invalid background colors", async () => {
  await expect(
    new IosPrototypeIconRenderer().render({ backgroundColor: "not a color" }, 120),
  ).rejects.toThrow("backgroundColor");
});
