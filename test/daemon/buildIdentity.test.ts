import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  computeBuildIdentity,
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  describeBuildIdentity,
  type BuildIdentity,
} from "../../src/daemon/buildIdentity";

describe("buildIdentity", () => {
  describe("computeBuildIdentity", () => {
    test("returns a stable hash for identical contents", () => {
      const hashFile = () => "deadbeefcafef00d";
      const a = computeBuildIdentity("/a/dist/index.js", hashFile);
      const b = computeBuildIdentity("/a/dist/index.js", hashFile);
      expect(a.buildId).toBe(b.buildId);
      expect(a.buildId).toBe("deadbeefcafef00d");
    });

    test("resolves the entry script to an absolute path", () => {
      const identity = computeBuildIdentity("/repo/dist/src/index.js", () => "abc123");
      // resolve() is platform-dependent (Windows prefixes a drive letter), so
      // compare against resolve() of the same input rather than a POSIX literal.
      expect(identity.entryScript).toBe(resolve("/repo/dist/src/index.js"));
    });

    test("returns different buildIds for different file contents", () => {
      const worktree = computeBuildIdentity("/wt/dist/index.js", () => "1111111111111111");
      const main = computeBuildIdentity("/main/dist/index.js", () => "2222222222222222");
      expect(worktree.buildId).not.toBe(main.buildId);
    });

    test("missing entry script yields an unknown identity without throwing", () => {
      const identity = computeBuildIdentity(undefined);
      expect(identity).toEqual({ entryScript: "", buildId: "unknown" });
    });

    test("unreadable entry script yields buildId 'unknown'", () => {
      const identity = computeBuildIdentity("/does/not/exist.js", () => {
        throw new Error("ENOENT");
      });
      expect(identity.entryScript).toBe(resolve("/does/not/exist.js"));
      expect(identity.buildId).toBe("unknown");
    });
  });

  describe("buildIdentitiesMatch", () => {
    const wt: BuildIdentity = { entryScript: "/wt/dist/index.js", buildId: "aaaa" };
    const wt2: BuildIdentity = { entryScript: "/wt/dist/index.js", buildId: "aaaa" };
    const main: BuildIdentity = { entryScript: "/main/dist/index.js", buildId: "bbbb" };

    test("same known buildId matches", () => {
      expect(buildIdentitiesMatch(wt, wt2)).toBe(true);
    });

    test("different known buildId does not match", () => {
      expect(buildIdentitiesMatch(wt, main)).toBe(false);
    });

    test("falls back to entryScript when one buildId is unknown", () => {
      const sameScriptUnknown: BuildIdentity = {
        entryScript: "/wt/dist/index.js",
        buildId: "unknown",
      };
      expect(buildIdentitiesMatch(wt, sameScriptUnknown)).toBe(true);

      const otherScriptUnknown: BuildIdentity = {
        entryScript: "/main/dist/index.js",
        buildId: "unknown",
      };
      expect(buildIdentitiesMatch(wt, otherScriptUnknown)).toBe(false);
    });

    test("missing identity on either side is treated as a match (backward compatible)", () => {
      const legacy: BuildIdentity = { entryScript: "", buildId: "unknown" };
      expect(buildIdentitiesMatch(wt, legacy)).toBe(true);
      expect(buildIdentitiesMatch(legacy, main)).toBe(true);
    });
  });

  describe("describeBuildIdentity", () => {
    test("renders '<buildId> (<entryScript>)' for a known identity", () => {
      const id: BuildIdentity = { entryScript: "/wt/dist/index.js", buildId: "aaaabbbbccccdddd" };
      expect(describeBuildIdentity(id)).toBe("aaaabbbbccccdddd (/wt/dist/index.js)");
    });

    test("falls back to 'unknown' entry script when it is empty", () => {
      const id: BuildIdentity = { entryScript: "", buildId: "unknown" };
      expect(describeBuildIdentity(id)).toBe("unknown (unknown)");
    });
  });

  describe("buildIdentityFromStatus", () => {
    test("projects populated status fields verbatim", () => {
      expect(
        buildIdentityFromStatus({ entryScript: "/wt/dist/index.js", buildId: "aaaa" }),
      ).toEqual({ entryScript: "/wt/dist/index.js", buildId: "aaaa" });
    });

    test("normalizes missing fields to '' / 'unknown' (legacy daemon)", () => {
      expect(buildIdentityFromStatus({})).toEqual({ entryScript: "", buildId: "unknown" });
    });

    test("a legacy projection matches any client (no false skew)", () => {
      const client: BuildIdentity = { entryScript: "/wt/dist/index.js", buildId: "aaaa" };
      expect(buildIdentitiesMatch(client, buildIdentityFromStatus({}))).toBe(true);
    });
  });
});
