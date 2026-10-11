import { describe, expect, test } from "bun:test";
import {
  UsageError,
  assertSafeOutputPath,
  parseCliArgs,
  parseWhen,
} from "../../scripts/ci/ciTimeToGreenArgs";

const NOW = Date.parse("2026-10-11T00:00:00Z");
const parse = (args: string[]) => parseCliArgs(args, NOW, "/repo", "/tmp");

describe("parseWhen", () => {
  test("accepts Nd / Nh relative to the anchor and ISO timestamps", () => {
    expect(parseWhen("3d", NOW, NOW)).toBe(NOW - 3 * 86_400_000);
    expect(parseWhen("6h", NOW, NOW)).toBe(NOW - 6 * 3_600_000);
    expect(parseWhen("2026-10-10T00:00:00Z", NOW, NOW)).toBe(Date.parse("2026-10-10T00:00:00Z"));
  });

  test("rejects garbage and future timestamps", () => {
    expect(() => parseWhen("yesterday", NOW, NOW)).toThrow(UsageError);
    expect(() => parseWhen("2027-01-01T00:00:00Z", NOW, NOW)).toThrow("future");
  });
});

describe("assertSafeOutputPath", () => {
  test("allows paths under <repo>/scratch and the temp dir only", () => {
    expect(assertSafeOutputPath("/repo/scratch/x/cache", "/repo", "/tmp")).toBe(
      "/repo/scratch/x/cache",
    );
    expect(assertSafeOutputPath("/tmp/abc", "/repo", "/tmp")).toBe("/tmp/abc");
    expect(() => assertSafeOutputPath("/repo/src", "/repo", "/tmp")).toThrow(UsageError);
    expect(() => assertSafeOutputPath("/repo/scratch/../src", "/repo", "/tmp")).toThrow(UsageError);
    expect(() => assertSafeOutputPath("/tmp", "/repo", "/tmp")).toThrow(UsageError);
  });
});

describe("parseCliArgs", () => {
  test("defaults to the last 7 days", () => {
    const options = parse([]);
    expect(options.untilMs).toBe(NOW);
    expect(options.sinceMs).toBe(NOW - 7 * 86_400_000);
    expect(options.maxApiCalls).toBe(4000);
    expect(options.json).toBe(false);
  });

  test("--since is relative to --until when --until is given", () => {
    const options = parse(["--until", "2026-10-10T00:00:00Z", "--since", "1d"]);
    expect(options.sinceMs).toBe(Date.parse("2026-10-09T00:00:00Z"));
  });

  test("rejects unknown flags, bad numbers, bad PR types and an inverted window", () => {
    expect(() => parse(["--bogus"])).toThrow(UsageError);
    expect(() => parse(["--max-api-calls", "0"])).toThrow(UsageError);
    expect(() => parse(["--pr-type", "docs"])).toThrow(UsageError);
    expect(() =>
      parse(["--since", "2026-10-10T00:00:00Z", "--until", "2026-10-09T00:00:00Z"]),
    ).toThrow(UsageError);
    expect(() => parse(["--from-bundle", "a", "--save-bundle", "/tmp/b"])).toThrow(
      "mutually exclusive",
    );
  });
});
