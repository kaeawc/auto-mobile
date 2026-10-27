import { describe, expect, test } from "bun:test";
import { DefaultGitMetadataClient } from "../../src/utils/GitMetadataClient";
import { FakeGitMetadataReader } from "../fakes/FakeFileSystem";
import { isGitVersionProbe } from "./testPreload";

describe("isGitVersionProbe", () => {
  test("accepts async status/diff and synchronous fallback HEAD probes", async () => {
    for (const fallback of [false, true]) {
      const probes: string[][] = [];
      const client = new DefaultGitMetadataClient(
        (command, args) => {
          probes.push([command, ...args]);
          if (args[0] === "rev-parse") {
            return "1a2b3c4d5e6f7890123456789012345678901234";
          }
          return fallback ? "tracked edit" : "";
        },
        new FakeGitMetadataReader({
          "/src/auto-mobile/.git": null,
          "/src/auto-mobile/.git/HEAD": fallback
            ? "unresolvable"
            : "1a2b3c4d5e6f7890123456789012345678901234",
        }),
        async (command, args) => {
          probes.push([command, ...args]);
          return fallback ? "tracked edit" : "";
        },
        {},
      );

      client.readVersion("/src/auto-mobile", () => "@kaeawc/auto-mobile");
      expect(probes).toHaveLength(fallback ? 1 : 0);
      await client.readDirtyState("/src/auto-mobile");
      expect(probes).toHaveLength(fallback ? 3 : 1);
      for (const argv of probes) {
        expect(isGitVersionProbe(argv)).toBe(true);
      }
    }
  });

  test("continues detecting legacy probes to catch regressions", () => {
    expect(isGitVersionProbe(["git", "rev-parse", "--show-toplevel"])).toBe(true);
    expect(isGitVersionProbe(["git", "rev-parse", "--short=12", "HEAD"])).toBe(true);
  });

  test.each([
    ["git", "grep", "-l", "--", "some-pattern"],
    ["git", "ls-files"],
    ["git"],
    [],
    ["other", "rev-parse", "--show-toplevel"],
    ["git", "rev-parse", "--short=12"],
    ["git", "rev-parse", "--short=12", "other-ref"],
    ["git", "rev-parse", "--show-toplevel", "extra"],
    ["git", "status", "--porcelain"],
    ["git", "rev-parse", "other-ref"],
    ["git", "rev-parse", "HEAD", "extra"],
    ["git", "diff"],
    ["git", "diff", "HEAD", "extra"],
  ])("ignores unrelated or incomplete argv: %j", (...argv: string[]) => {
    expect(isGitVersionProbe(argv)).toBe(false);
  });
});
