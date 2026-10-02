import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../../src/features/observe/ScreenshotRetention";
import { describe, expect, test } from "bun:test";
import { selectScreenshotsToEvict } from "../../../src/features/observe/screenshotCacheEviction";

const MB = 1024 * 1024;

describe("selectScreenshotsToEvict", () => {
  test("returns nothing when under the size limit", () => {
    const files = [
      { path: "a", size: 10 * MB, mtimeMs: 0 },
      { path: "b", size: 10 * MB, mtimeMs: 0 },
    ];
    expect(
      selectScreenshotsToEvict(files, 100 * MB, SCREENSHOT_PATH_MIN_LIFETIME_MS, 1_000_000),
    ).toEqual({
      toEvict: [],
      overBudgetAfterEviction: false,
      skippedReferenced: 0,
    });
  });

  test("evicts oldest-first until under the limit", () => {
    const now = 1_000_000;
    const old = now - SCREENSHOT_PATH_MIN_LIFETIME_MS - 2; // older than minAge — evictable
    const files = [
      { path: "newest", size: 40 * MB, mtimeMs: old + 2 },
      { path: "oldest", size: 40 * MB, mtimeMs: old },
      { path: "middle", size: 40 * MB, mtimeMs: old + 1 },
    ];
    // total 120MB, limit 100MB → must drop 40MB → the single oldest file.
    expect(selectScreenshotsToEvict(files, 100 * MB, SCREENSHOT_PATH_MIN_LIFETIME_MS, now)).toEqual(
      {
        toEvict: ["oldest"],
        overBudgetAfterEviction: false,
        skippedReferenced: 0,
      },
    );
  });

  test("never evicts a file younger than minAge (another process's in-flight frame)", () => {
    const now = 1_000_000;
    const files = [
      { path: "recent-1", size: 80 * MB, mtimeMs: now - 1_000 }, // 1s old — protected
      { path: "recent-2", size: 80 * MB, mtimeMs: now - 2_000 }, // 2s old — protected
    ];
    // Over the limit, but both files are too recent to evict → keep both.
    expect(selectScreenshotsToEvict(files, 100 * MB, SCREENSHOT_PATH_MIN_LIFETIME_MS, now)).toEqual(
      {
        toEvict: [],
        overBudgetAfterEviction: true,
        skippedReferenced: 0,
      },
    );
  });

  test("evicts only the old files, protecting recent ones, even if still over limit", () => {
    const now = 1_000_000;
    const files = [
      { path: "old", size: 60 * MB, mtimeMs: now - SCREENSHOT_PATH_MIN_LIFETIME_MS - 2 }, // evictable
      { path: "recent", size: 60 * MB, mtimeMs: now - 1_000 }, // protected
    ];
    // total 120MB, limit 50MB. Only "old" can go; "recent" stays even though we
    // remain over limit (correctness over disk bound for in-flight safety).
    expect(selectScreenshotsToEvict(files, 50 * MB, SCREENSHOT_PATH_MIN_LIFETIME_MS, now)).toEqual({
      toEvict: ["old"],
      overBudgetAfterEviction: true,
      skippedReferenced: 0,
    });
  });

  test("satisfies the budget by evicting unreferenced files before referenced files", () => {
    const now = 1_000_000;
    const files = [
      { path: "cached", size: 40 * MB, mtimeMs: now - SCREENSHOT_PATH_MIN_LIFETIME_MS - 2 },
      {
        path: "unreferenced",
        size: 50 * MB,
        mtimeMs: now - SCREENSHOT_PATH_MIN_LIFETIME_MS - 120_000,
      },
      {
        path: "unreferenced-2",
        size: 50 * MB,
        mtimeMs: now - SCREENSHOT_PATH_MIN_LIFETIME_MS - 180_000,
      },
    ];
    const referenced = new Set(["cached"]);

    expect(
      selectScreenshotsToEvict(files, 50 * MB, SCREENSHOT_PATH_MIN_LIFETIME_MS, now, (filePath) =>
        referenced.has(filePath),
      ),
    ).toEqual({
      toEvict: ["unreferenced-2", "unreferenced"],
      overBudgetAfterEviction: false,
      skippedReferenced: 0,
    });
  });

  test("keeps referenced screenshots when they alone prevent meeting the budget", () => {
    const now = 1_000_000;
    const files = [
      { path: "cached", size: 60 * MB, mtimeMs: now - SCREENSHOT_PATH_MIN_LIFETIME_MS - 2 },
      {
        path: "unreferenced",
        size: 60 * MB,
        mtimeMs: now - SCREENSHOT_PATH_MIN_LIFETIME_MS - 120_000,
      },
    ];

    expect(
      selectScreenshotsToEvict(
        files,
        50 * MB,
        SCREENSHOT_PATH_MIN_LIFETIME_MS,
        now,
        (filePath) => filePath === "cached",
      ),
    ).toEqual({
      toEvict: ["unreferenced"],
      overBudgetAfterEviction: true,
      skippedReferenced: 1,
    });
  });
});
