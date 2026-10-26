import { beforeAll, expect, test } from "bun:test";
import {
  generateFeedSpec,
  MAX_ROWS,
  parseFeedOptions,
} from "../../scripts/prototype/generate-feed-benchmark-spec";
import { validatePrototypeSpec } from "../../src/features/prototype/prototypeValidation";

// Initialize the shared validator schema before measuring individual unit cases.
beforeAll(() => {
  validatePrototypeSpec(generateFeedSpec(parseFeedOptions(["--rows", "1"])));
});

for (const rows of [1000, MAX_ROWS]) {
  test(`${rows} feed rows validate with unique stable keys`, () => {
    const spec = generateFeedSpec(parseFeedOptions(["--rows", String(rows)]));
    const result = validatePrototypeSpec(spec);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(spec.data.feed.items).toHaveLength(rows);
    expect(new Set(spec.data.feed.items.map((row) => row.id)).size).toBe(rows);
    expect(spec.root.contentDescription).toBe("Benchmark feed");
    expect(spec.root.onEndReached).toBeUndefined();
  });
}
test("default feed is deterministic and fullscreen", () => {
  const first = generateFeedSpec(parseFeedOptions([]));
  expect(first).toEqual(generateFeedSpec(parseFeedOptions([])));
  expect(first.id).toBe("perf-feed");
  expect(first.window.placement.type).toBe("fullscreen");
  expect(first.data.feed.items).toHaveLength(1000);
});
test("paging appends fixture items into a bounded feed", () => {
  const options = parseFeedOptions([
    "--paging",
    "--page-url",
    "http://localhost:8080/page",
    "--out",
    "feed.json",
  ]);
  const spec = generateFeedSpec(options);
  expect(options.out).toBe("feed.json");
  expect(validatePrototypeSpec(spec).success).toBe(true);
  expect(spec.root.maxItems).toBe(MAX_ROWS);
  expect(spec.root.onEndReached?.[0]).toEqual({
    type: "request",
    url: "http://localhost:8080/page",
    append: { from: "/items", to: "/data/feed/items" },
  });
});
test("flag validation rejects bad rows, paging URLs and unknown arguments", () => {
  for (const value of ["0", "-1", "1.5", "nope", "1e3", String(MAX_ROWS + 1), "9".repeat(30)]) {
    expect(() => parseFeedOptions([`--rows=${value}`])).toThrow("--rows must be an integer");
  }
  for (const args of [
    ["--paging"],
    ["--page-url", "http://localhost/page"],
    ["--paging", "--page-url", "ftp://localhost/page"],
    ["--paging", "--page-url", "http://user:password@localhost/page"],
    ["--paging", "--page-url", "bad"],
    ["--rows"],
    ["--out"],
    ["--bogus"],
    ["positional"],
  ])
    expect(() => parseFeedOptions(args)).toThrow();
  expect(parseFeedOptions(["--rows", "1"]).rows).toBe(1);
});
