import { describe, expect, test } from "bun:test";
import {
  formatMcpServerVersion,
  readGitVersion,
  releaseVersion,
  resolveMcpServerVersion,
  type GitVersionInfo,
  type McpVersionDeps,
} from "../../src/utils/mcpVersion";
import { compareVersions } from "../../src/server/deviceMatcher";

const git = (shortSha: string, dirty = false): GitVersionInfo => ({ shortSha, dirty });

describe("releaseVersion", () => {
  test("returns the version unchanged when there is no build metadata", () => {
    expect(releaseVersion("0.0.39")).toBe("0.0.39");
  });

  test("strips the git-SHA build metadata", () => {
    expect(releaseVersion("0.0.39+g1a2b3c4d5e6f")).toBe("0.0.39");
  });

  test("strips the dirty marker too", () => {
    expect(releaseVersion("0.0.39+g1a2b3c4d5e6f.dirty")).toBe("0.0.39");
  });
});

describe("formatMcpServerVersion", () => {
  test("returns the base version unchanged when there is no git info (release build)", () => {
    expect(formatMcpServerVersion("0.0.39", null)).toBe("0.0.39");
  });

  test("returns the base version unchanged when the short SHA is empty", () => {
    expect(formatMcpServerVersion("0.0.39", git(""))).toBe("0.0.39");
  });

  test("stamps the git short SHA as semver build metadata", () => {
    expect(formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f"))).toBe("0.0.39+g1a2b3c4d5e6f");
  });

  test("appends a dirty marker when the working tree is dirty", () => {
    expect(formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f", true))).toBe("0.0.39+g1a2b3c4d5e6f.dirty");
  });

  test("two different commits yield two different version strings", () => {
    const a = formatMcpServerVersion("0.0.39", git("aaaaaaaaaaaa"));
    const b = formatMcpServerVersion("0.0.39", git("bbbbbbbbbbbb"));
    expect(a).not.toBe(b);
  });

  test("a clean vs dirty checkout at the same commit are distinguished", () => {
    const clean = formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f", false));
    const dirty = formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f", true));
    expect(clean).not.toBe(dirty);
  });
});

describe("formatMcpServerVersion + the daemon version gate", () => {
  // The stamp is semver build metadata: it makes the *string* vary with the
  // commit (for doctor/logs/DaemonVersionMismatchError diagnostics) while the
  // release portion before `+` stays stable. The version gate compares the
  // release portion and defers same-release dev-skew to the build-identity gate.
  test("stamped dev builds share the same release portion (gate treats them as same-release)", () => {
    const a = formatMcpServerVersion("0.0.39", git("aaaaaaaaaaaa"));
    const b = formatMcpServerVersion("0.0.39", git("bbbbbbbbbbbb"));
    expect(a.split("+")[0]).toBe(b.split("+")[0]);
    expect(compareVersions(a.split("+")[0], b.split("+")[0])).toBe(0);
  });

  test("the full stamped string still varies with the commit (diagnostics distinguish them)", () => {
    const a = formatMcpServerVersion("0.0.39", git("aaaaaaaaaaaa"));
    const b = formatMcpServerVersion("0.0.39", git("bbbbbbbbbbbb"));
    expect(a).not.toBe(b);
  });

  test("a genuine release-version bump still compares numerically across stamps", () => {
    const older = formatMcpServerVersion("0.0.39", git("aaaaaaaaaaaa"));
    const newer = formatMcpServerVersion("0.0.40", git("bbbbbbbbbbbb"));
    expect(compareVersions(newer.split("+")[0], older.split("+")[0])).toBeGreaterThan(0);
  });
});

describe("readGitVersion", () => {
  // Fake git runner: maps each git invocation (keyed by first arg) to canned
  // stdout. Keeps these tests pure — no spawn, no real repo. `readName` is
  // injected too so the ownership check needs no filesystem.
  const OWN = "@kaeawc/auto-mobile";
  const fakeRun = (responses: Record<string, string | null>) =>
    (_cwd: string, args: string[]): string | null => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {return responses.toplevel ?? null;}
      if (args[0] === "rev-parse" && args[1] === "--short=12") {return responses.sha ?? null;}
      if (args[0] === "status") {return responses.status ?? null;}
      return null;
    };
  const ownsRepo = () => OWN;

  test("returns null for a node_modules location without consulting git (dependency install)", () => {
    let called = false;
    const run = (_c: string, _a: string[]) => { called = true; return null; };
    expect(readGitVersion("/host/node_modules/@kaeawc/auto-mobile/dist", run, ownsRepo)).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null when not inside a git work tree (release install)", () => {
    expect(readGitVersion("/opt/app", fakeRun({ toplevel: null }), ownsRepo)).toBeNull();
  });

  test("returns null when the enclosing repo is a different project (vendored release install)", () => {
    // git rev-parse walks upward; a copy nested in a host repo must not be
    // stamped with the host's commit.
    const run = fakeRun({ toplevel: "/host/repo", sha: "deadbeefcafe" });
    expect(readGitVersion("/host/repo/vendor/auto-mobile", run, () => "some-host-app")).toBeNull();
  });

  test("returns null when HEAD has no resolvable short SHA", () => {
    const run = fakeRun({ toplevel: "/src/auto-mobile", sha: null });
    expect(readGitVersion("/src/auto-mobile", run, ownsRepo)).toBeNull();
  });

  test("stamps a clean checkout of AutoMobile's own repo", () => {
    const run = fakeRun({ toplevel: "/src/auto-mobile", sha: "1a2b3c4d5e6f", status: "" });
    expect(readGitVersion("/src/auto-mobile", run, ownsRepo)).toEqual({ shortSha: "1a2b3c4d5e6f", dirty: false });
  });

  test("marks the checkout dirty when there are tracked changes", () => {
    const run = fakeRun({ toplevel: "/src/auto-mobile", sha: "1a2b3c4d5e6f", status: " M src/index.ts" });
    expect(readGitVersion("/src/auto-mobile", run, ownsRepo)).toEqual({ shortSha: "1a2b3c4d5e6f", dirty: true });
  });
});

describe("resolveMcpServerVersion", () => {
  const deps = (overrides: Partial<McpVersionDeps>): McpVersionDeps => ({
    env: {},
    readPackageVersion: () => "0.0.39",
    readGitVersion: () => git("1a2b3c4d5e6f"),
    ...overrides,
  });

  test("MCP_SERVER_VERSION override is returned verbatim, even inside a git checkout", () => {
    expect(
      resolveMcpServerVersion(deps({ env: { MCP_SERVER_VERSION: "9.9.9" } }))
    ).toBe("9.9.9");
  });

  test("npm_package_version is used as the base and stamped when git is present", () => {
    expect(
      resolveMcpServerVersion(
        deps({ env: { npm_package_version: "1.2.3" }, readGitVersion: () => git("abcdef123456") })
      )
    ).toBe("1.2.3+gabcdef123456");
  });

  test("package.json version is used as the base and stamped when git is present", () => {
    expect(resolveMcpServerVersion(deps({}))).toBe("0.0.39+g1a2b3c4d5e6f");
  });

  test("returns 'unknown' with no stamp when no base version can be resolved", () => {
    expect(
      resolveMcpServerVersion(deps({ readPackageVersion: () => null }))
    ).toBe("unknown");
  });

  test("release build (no git) reports the base version unchanged", () => {
    expect(
      resolveMcpServerVersion(deps({ readGitVersion: () => null }))
    ).toBe("0.0.39");
  });
});
