import { expect, describe, test } from "bun:test";
import {
  stitchBatchResults,
  type SimilarScreenshotResult,
} from "../../../src/utils/screenshot/ScreenshotMatcher";

describe("stitchBatchResults", () => {
  test("returns precise results for candidates in the original path order", () => {
    const paths = ["a.png", "b.png", "c.png"];
    const precise: SimilarScreenshotResult[] = [
      { filePath: "b.png", similarity: 99, matchFound: true },
      { filePath: "a.png", similarity: 40, matchFound: false },
    ];
    const stage1 = [
      { filePath: "a.png", perceptualSimilarity: 42 },
      { filePath: "b.png", perceptualSimilarity: 95 },
      { filePath: "c.png", perceptualSimilarity: 30 },
    ];

    const result = stitchBatchResults(paths, precise, stage1);

    expect(result.map((r) => r.filePath)).toEqual(["a.png", "b.png", "c.png"]);
    // Candidates keep their precise result...
    expect(result[0]).toEqual({ filePath: "a.png", similarity: 40, matchFound: false });
    expect(result[1]).toEqual({ filePath: "b.png", similarity: 99, matchFound: true });
    // ...non-candidate falls back to stage-1 perceptual similarity.
    expect(result[2]).toEqual({ filePath: "c.png", similarity: 30, matchFound: false });
  });

  test("falls back to 0 when there is no precise and no stage-1 entry", () => {
    const result = stitchBatchResults(["x.png"], [], []);
    expect(result).toEqual([{ filePath: "x.png", similarity: 0, matchFound: false }]);
  });

  test("tolerates null entries in stage1Results", () => {
    const result = stitchBatchResults(
      ["x.png", "y.png"],
      [],
      [null, { filePath: "y.png", perceptualSimilarity: 55 }],
    );
    expect(result).toEqual([
      { filePath: "x.png", similarity: 0, matchFound: false },
      { filePath: "y.png", similarity: 55, matchFound: false },
    ]);
  });

  test("prefers a precise result over the stage-1 fallback for the same path", () => {
    const result = stitchBatchResults(
      ["p.png"],
      [{ filePath: "p.png", similarity: 88, matchFound: false }],
      [{ filePath: "p.png", perceptualSimilarity: 70 }],
    );
    expect(result).toEqual([{ filePath: "p.png", similarity: 88, matchFound: false }]);
  });

  test("handles a large batch without quadratic scanning (order preserved)", () => {
    const n = 1000;
    const paths = Array.from({ length: n }, (_, i) => `s${i}.png`);
    // No precise results; every path uses its stage-1 similarity.
    const stage1 = paths.map((filePath, i) => ({ filePath, perceptualSimilarity: i % 100 }));

    const result = stitchBatchResults(paths, [], stage1);

    expect(result).toHaveLength(n);
    expect(result[0]).toEqual({ filePath: "s0.png", similarity: 0, matchFound: false });
    expect(result[999]).toEqual({ filePath: "s999.png", similarity: 99, matchFound: false });
  });
});
