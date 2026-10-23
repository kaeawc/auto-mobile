import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { markSpotlightExcluded } from "../../src/utils/spotlightExclusion";
import { logger } from "../../src/utils/logger";

test("Darwin creates a marker through injected fs", async () => {
  const paths: string[] = [];
  await markSpotlightExcluded(
    "/cache",
    {
      writeFile: async (path) => {
        paths.push(path);
      },
    },
    "darwin",
  );
  expect(paths).toEqual([join("/cache", ".metadata_never_index")]);
});
test("non-Darwin performs no IO", async () => {
  const paths: string[] = [];
  await markSpotlightExcluded(
    "/cache",
    {
      writeFile: async (path) => {
        paths.push(path);
      },
    },
    "linux",
  );
  expect(paths).toEqual([]);
});
test("optional marker write failure is swallowed", async () => {
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    await markSpotlightExcluded(
      "/cache",
      {
        writeFile: async () => {
          throw new Error("read only");
        },
      },
      "darwin",
    );
    expect(debug).toHaveBeenCalled();
  } finally {
    debug.mockRestore();
  }
});
