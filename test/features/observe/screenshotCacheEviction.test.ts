import { describe, expect, test } from "bun:test";
import { selectScreenshotsToEvict } from "../../../src/features/observe/screenshotCacheEviction";

const MB = 1024 * 1024;

describe("selectScreenshotsToEvict", () => {
  test("returns nothing when under the size limit", () => {
    const files = [
      { path: "a", size: 10 * MB, mtimeMs: 0 },
      { path: "b", size: 10 * MB, mtimeMs: 0 },
    ];
    expect(selectScreenshotsToEvict(files, 100 * MB, 30_000, 1_000_000)).toEqual([]);
  });

  test("evicts oldest-first until under the limit", () => {
    const now = 1_000_000;
    const old = now - 60_000; // older than minAge — evictable
    const files = [
      { path: "newest", size: 40 * MB, mtimeMs: old + 2 },
      { path: "oldest", size: 40 * MB, mtimeMs: old },
      { path: "middle", size: 40 * MB, mtimeMs: old + 1 },
    ];
    // total 120MB, limit 100MB → must drop 40MB → the single oldest file.
    expect(selectScreenshotsToEvict(files, 100 * MB, 30_000, now)).toEqual(["oldest"]);
  });

  test("never evicts a file younger than minAge (another process's in-flight frame)", () => {
    const now = 1_000_000;
    const files = [
      { path: "recent-1", size: 80 * MB, mtimeMs: now - 1_000 }, // 1s old — protected
      { path: "recent-2", size: 80 * MB, mtimeMs: now - 2_000 }, // 2s old — protected
    ];
    // Over the limit, but both files are too recent to evict → keep both.
    expect(selectScreenshotsToEvict(files, 100 * MB, 30_000, now)).toEqual([]);
  });

  test("evicts only the old files, protecting recent ones, even if still over limit", () => {
    const now = 1_000_000;
    const files = [
      { path: "old", size: 60 * MB, mtimeMs: now - 60_000 }, // evictable
      { path: "recent", size: 60 * MB, mtimeMs: now - 1_000 }, // protected
    ];
    // total 120MB, limit 50MB. Only "old" can go; "recent" stays even though we
    // remain over limit (correctness over disk bound for in-flight safety).
    expect(selectScreenshotsToEvict(files, 50 * MB, 30_000, now)).toEqual(["old"]);
  });
});
