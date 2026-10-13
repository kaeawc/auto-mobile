import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    // The function returns path.resolve(...) output: drive-prefixed and backslashed on win32.
    expect(assertSafeOutputPath("/repo/scratch/x/cache", "/repo", "/tmp")).toBe(
      resolve("/repo/scratch/x/cache"),
    );
    expect(assertSafeOutputPath("/tmp/abc", "/repo", "/tmp")).toBe(resolve("/tmp/abc"));
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
    expect(options.maxApiCalls).toBe(500);
    expect(options.json).toBe(false);
  });

  test("a call budget above 1000 needs --allow-large-api-budget and says why", () => {
    expect(parse(["--max-api-calls", "1000"]).maxApiCalls).toBe(1000);
    expect(() => parse(["--max-api-calls", "1001"])).toThrow("--allow-large-api-budget");
    expect(() => parse(["--max-api-calls", "1001"])).toThrow("5,000");
    expect(parse(["--max-api-calls", "4000", "--allow-large-api-budget"]).maxApiCalls).toBe(4000);
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

test("parses Namespace overrides and CircleCI flags with checkout defaults", () => {
  const defaults = parse([]);
  expect(defaults.circleci).toBe(true);
  expect(defaults.namespaceVcpus).toEqual({});
  expect(defaults.circleciConfig).toBe(resolve("/repo/.circleci/continue_config.yml"));
  const options = parse([
    "--namespace-vcpus",
    "namespace-profile-auto-mobile=8,namespace-custom=2",
    "--no-circleci",
    "--circleci-config",
    "custom.yml",
  ]);
  expect(options.namespaceVcpus).toEqual({
    "namespace-profile-auto-mobile": 8,
    "namespace-custom": 2,
  });
  expect(options.circleci).toBe(false);
  expect(options.circleciConfig).toBe("custom.yml");
});

test("rejects malformed vCPU overrides", () => {
  for (const value of [
    "",
    "foo",
    "foo=2",
    "namespace-x=0",
    "namespace-x=-1",
    "namespace-x=1.5",
    "namespace-x=2,",
    "namespace-x=9007199254740992",
    "namespace-x=2=3",
  ]) {
    expect(() => parse(["--namespace-vcpus", value])).toThrow(UsageError);
  }
  expect(() => parse(["--circleci-config"])).toThrow(UsageError);
});

test("BATS setup uses the caller's temp directory without a checkout scratch prerequisite", () => {
  const source = readFileSync(resolve(import.meta.dir, "../bats/ci-time-to-green.bats"), "utf8");
  expect(source).toContain('TEST_ROOT="$(mktemp -d)"');
  expect(source).toContain('export TMPDIR="$TEST_ROOT"');
});

test("main-push CircleCI statuses require an explicit opt-in", () => {
  expect(parse([]).circleciMainPushes).toBe(false);
  expect(parse(["--circleci-main-pushes"]).circleciMainPushes).toBe(true);
});
