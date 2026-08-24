import { describe, test } from "bun:test";
import fc from "fast-check";
import type { GitVersionInfo } from "../../src/utils/GitMetadataClient";
import {
  formatMcpServerVersion,
  releaseVersion,
  resolveMcpServerVersion,
} from "../../src/utils/mcpVersion";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Hex tokens model git short SHAs and tracked-diff hashes — the only content the
// stamp ever appends after the `+` separator, so the separator stays unambiguous.
const hex = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 1, maxLength: 12 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

// A base version is any non-empty string that carries no `+` (semver build-
// metadata separator) and is not the "unknown" sentinel. Semver triples are the
// realistic case; arbitrary no-plus strings widen the domain.
const noPlusString = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => !s.includes("+") && s !== "unknown");
const semver = fc.tuple(fc.nat(999), fc.nat(999), fc.nat(999)).map(([a, b, c]) => `${a}.${b}.${c}`);
const baseVersion = fc.oneof(semver, noPlusString);

const gitInfo: fc.Arbitrary<GitVersionInfo> = fc.record({
  shortSha: hex,
  dirty: fc.boolean(),
  dirtyHash: fc.option(hex, { nil: null }),
});

describe("releaseVersion (property-based)", () => {
  test("output never contains the build-metadata separator", () => {
    fc.assert(
      fc.property(fc.string(), (v) => !releaseVersion(v).includes("+")),
      RUN_OPTIONS,
    );
  });

  test("is a prefix of its input and idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (v) => {
        const once = releaseVersion(v);
        return v.startsWith(once) && releaseVersion(once) === once;
      }),
      RUN_OPTIONS,
    );
  });

  test("is the identity on strings that carry no separator", () => {
    fc.assert(
      fc.property(baseVersion, (base) => releaseVersion(base) === base),
      RUN_OPTIONS,
    );
  });
});

describe("formatMcpServerVersion (property-based)", () => {
  test("stamping then stripping recovers the base version (round-trip)", () => {
    fc.assert(
      fc.property(
        baseVersion,
        gitInfo,
        (base, git) => releaseVersion(formatMcpServerVersion(base, git)) === base,
      ),
      RUN_OPTIONS,
    );
  });

  test("no git info (or an empty SHA) leaves the base unchanged", () => {
    const emptyOrNull = fc.oneof(
      fc.constant(null),
      gitInfo.map((g) => ({ ...g, shortSha: "" })),
    );
    fc.assert(
      fc.property(
        baseVersion,
        emptyOrNull,
        (base, git) => formatMcpServerVersion(base, git) === base,
      ),
      RUN_OPTIONS,
    );
  });

  test("a real SHA prefixes the stamp and reflects the dirty marker exactly", () => {
    fc.assert(
      fc.property(baseVersion, gitInfo, (base, git) => {
        const stamped = formatMcpServerVersion(base, git);
        return (
          stamped.startsWith(`${base}+g${git.shortSha}`) && stamped.includes(".dirty") === git.dirty
        );
      }),
      RUN_OPTIONS,
    );
  });
});

describe("resolveMcpServerVersion (property-based)", () => {
  test("an explicit MCP_SERVER_VERSION override is returned verbatim, never stamped", () => {
    const override = fc.string({ minLength: 1, maxLength: 24 });
    fc.assert(
      fc.property(
        override,
        fc.option(baseVersion, { nil: undefined }),
        gitInfo,
        (value, npm, git) => {
          return (
            resolveMcpServerVersion({
              env: { MCP_SERVER_VERSION: value, npm_package_version: npm },
              readPackageVersion: () => "9.9.9",
              readGitVersion: () => git,
            }) === value
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("with no override and no resolvable base, the result is 'unknown'", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", undefined),
        fc.constantFrom("", undefined),
        gitInfo,
        (override, npm, git) => {
          return (
            resolveMcpServerVersion({
              env: { MCP_SERVER_VERSION: override, npm_package_version: npm },
              readPackageVersion: () => null,
              readGitVersion: () => git,
            }) === "unknown"
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("a resolved (non-override) base survives a release-version round-trip", () => {
    // env base takes precedence over readPackageVersion; when env is empty the
    // package fallback is used. Either way, stripping the stamp yields the base.
    const source = fc.constantFrom("env", "package");
    fc.assert(
      fc.property(baseVersion, source, fc.option(gitInfo, { nil: null }), (base, source_, git) => {
        const fromEnv = source_ === "env";
        const resolved = resolveMcpServerVersion({
          env: { MCP_SERVER_VERSION: undefined, npm_package_version: fromEnv ? base : "" },
          readPackageVersion: () => (fromEnv ? "should-not-be-read" : base),
          readGitVersion: () => git,
        });
        return releaseVersion(resolved) === base;
      }),
      RUN_OPTIONS,
    );
  });
});
