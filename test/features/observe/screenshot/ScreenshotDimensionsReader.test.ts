import { expect, test } from "bun:test";
import { HeaderScreenshotDimensionsReader } from "../../../../src/features/observe/screenshot/ScreenshotDimensionsReader";

test("reads an existing PNG fixture's raster using only container headers", async () => {
  const reader = new HeaderScreenshotDimensionsReader();
  expect(await reader.read("test/fixtures/screenshots/black-on-white.png")).toEqual({
    width: 100,
    height: 50,
  });
});

test("unrecognized file headers return no dimensions", async () => {
  expect(await new HeaderScreenshotDimensionsReader().read("CLAUDE.md")).toBeNull();
});

test("missing files reject for the observe boundary to log and omit metadata", async () => {
  await expect(
    new HeaderScreenshotDimensionsReader().read("scratch/rastersize/missing-file.png"),
  ).rejects.toThrow();
});
