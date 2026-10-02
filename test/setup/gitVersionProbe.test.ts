import { describe, expect, test } from "bun:test";
import { DefaultGitMetadataClient } from "../../src/utils/GitMetadataClient";
import { isGitVersionProbe } from "./testPreload";

describe("isGitVersionProbe", () => {
  test("accepts all three version probes issued by GitMetadataClient", () => {
    const probes: string[][] = [];
    const client = new DefaultGitMetadataClient((command, args) => {
      probes.push([command, ...args]);
      if (args[1] === "--show-toplevel") {
        return "/src/auto-mobile";
      }
      return args[1] === "--short=12" ? "1a2b3c4d5e6f" : "";
    });

    client.readVersion("/src/auto-mobile", () => "@kaeawc/auto-mobile");

    expect(probes).toHaveLength(3);
    for (const argv of probes) {
      expect(isGitVersionProbe(argv)).toBe(true);
    }
  });

  test.each([
    ["git", "grep", "-l", "--", "webrtc-coordination-server"],
    ["git", "ls-files"],
    ["git"],
    [],
    ["other", "rev-parse", "--show-toplevel"],
    ["git", "rev-parse", "--short=12"],
    ["git", "rev-parse", "--short=12", "other-ref"],
    ["git", "rev-parse", "--show-toplevel", "extra"],
    ["git", "status", "--porcelain"],
  ])("ignores unrelated or incomplete argv: %j", (...argv: string[]) => {
    expect(isGitVersionProbe(argv)).toBe(false);
  });
});
