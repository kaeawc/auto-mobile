import { describe, expect, spyOn, test } from "bun:test";
import {
  formatMcpServerVersion,
  createMcpVersionResolver,
  getMcpServerVersion,
  readGitVersion,
  releaseVersion,
  resolveMcpServerVersion,
  withoutDirtyStamp,
  probeCheckoutMcpServerVersion,
  type GitVersionInfo,
  type McpVersionDeps,
} from "../../src/utils/mcpVersion";
import {
  DefaultGitMetadataClient,
  defaultGitMetadataClient,
} from "../../src/utils/GitMetadataClient";
import type { GitDirtyState, GitMetadataClient } from "../../src/utils/GitMetadataClient";
import { compareVersions } from "../../src/utils/deviceMatcher";
import { testOverrides } from "../../src/utils/testOverrides";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { FakeGitMetadataReader } from "../fakes/FakeFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import { defaultTimer } from "../../src/utils/SystemTimer";
import * as env from "../../src/config/env";

const versionModulePath = "../../src/utils/mcpVersion.ts";

test("checkout probes resolve fresh inputs rather than reusing a cached stamp", async () => {
  const read = spyOn(env, "readEnvRaw").mockReturnValue("0.0.87+gabc");
  try {
    expect(await probeCheckoutMcpServerVersion()).toBe("0.0.87+gabc");
    read.mockReturnValue("0.0.87+gabc.dirty.47e2");
    expect(await probeCheckoutMcpServerVersion()).toBe("0.0.87+gabc.dirty.47e2");
  } finally {
    read.mockRestore();
  }
});

describe("withoutDirtyStamp", () => {
  test.each([
    ["0.0.87+gabc.dirty.47e2", "0.0.87+gabc"],
    ["0.0.87+gabc.dirty", "0.0.87+gabc"],
    ["0.0.87+gabc", "0.0.87+gabc"],
    ["0.0.87", "0.0.87"],
    ["0.0.87-dirty", "0.0.87-dirty"],
    ["0.0.87.dirty", "0.0.87.dirty"],
    ["0.0.87+other.dirty.47e2", "0.0.87+other.dirty.47e2"],
    ["0.0.87+gabc.dirty.nothex", "0.0.87+gabc.dirty.nothex"],
    ["0.0.87+gabc.dirty.47e2.more", "0.0.87+gabc.dirty.47e2.more"],
  ])("%s -> %s", (version, expected) => {
    expect(withoutDirtyStamp(version)).toBe(expected);
  });
});

describe("getMcpServerVersion laziness", () => {
  test("import and the first getter never spawn status/diff, then cache the stamp", async () => {
    const original = testOverrides.gitMetadataClient;
    const commands: string[][] = [];
    const timer = new FakeTimer();
    const handles: NodeJS.Timeout[] = [];
    const schedule = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) => {
      const handle = timer.setTimeout(callback, ms);
      handles.push(handle);
      return handle;
    });
    const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
    const fs = new FakeGitMetadataReader({
      [join(root, ".git")]: null,
      [join(root, ".git/HEAD")]: "abcdef1234567890123456789012345678901234",
    });
    testOverrides.gitMetadataClient = new DefaultGitMetadataClient(
      (_command, args) => {
        commands.push([...args]);
        return "";
      },
      fs,
      async (_command, args) => {
        commands.push([...args]);
        return null;
      },
      {},
    );
    try {
      const version: typeof import("../../src/utils/mcpVersion") = await import(
        `${versionModulePath}?lazy-cache`
      );
      expect(commands).toEqual([]);
      const first = version.getMcpServerVersion();
      expect(first).toMatch(/^\d+\.\d+\.\d+\+gabcdef123456$/);
      expect(commands).toEqual([]);
      expect(version.getMcpServerVersion()).toBe(first);
      expect(commands).toHaveLength(0);
      expect(timer.getPendingTimeouts()).toEqual([0]);
      expect(handles).toHaveLength(1);
      expect(handles[0].hasRef()).toBe(false);
      timer.advanceTime(0);
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect(commands).toEqual([["status", "--porcelain", "--untracked-files=no"]]);
      expect(version.getMcpServerVersion()).toBe(first);
    } finally {
      testOverrides.gitMetadataClient = original;
      schedule.mockRestore();
    }
  });

  test("the preload override returns the unstamped manifest version without a git runner", async () => {
    const probe = spyOn(defaultGitMetadataClient, "readVersion").mockReturnValue(null);
    try {
      expect(testOverrides.gitMetadataClient).toBeDefined();
      const version: typeof import("../../src/utils/mcpVersion") = await import(
        `${versionModulePath}?preload-override`
      );
      expect(version.getMcpServerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(version.getMcpServerVersion()).toBe(getMcpServerVersion());
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });
});

const git = (shortSha: string, dirty = false, dirtyHash: string | null = null): GitVersionInfo => ({
  shortSha,
  dirty,
  dirtyHash,
});

describe("createMcpVersionResolver", () => {
  const plain = "0.0.39+g1a2b3c4d5e6f";
  const fixture = (
    readDirtyState: () => Promise<GitDirtyState | null> = async () => ({
      dirty: true,
      dirtyHash: "abc123def456",
    }),
    overrides: Partial<McpVersionDeps> = {},
  ) => {
    const timer = new FakeTimer();
    let dirtyReads = 0;
    let versionReads = 0;
    let packageReads = 0;
    const client: GitMetadataClient = {
      readVersion: () => {
        versionReads++;
        return git("1a2b3c4d5e6f");
      },
      readDirtyState: async () => {
        dirtyReads++;
        return readDirtyState();
      },
    };
    const resolver = createMcpVersionResolver({
      env: {},
      readPackageVersion: () => {
        packageReads++;
        return "0.0.39";
      },
      readGitVersion: () => client.readVersion("/src/auto-mobile", () => "@kaeawc/auto-mobile"),
      timer,
      readDirtyState: () => client.readDirtyState("/src/auto-mobile"),
      ...overrides,
    });
    return { resolver, timer, counts: () => ({ dirtyReads, versionReads, packageReads }) };
  };

  test("settlement starts refinement without waiting for an unref timer and shares the result", async () => {
    const pending = Promise.withResolvers<GitDirtyState | null>();
    const { resolver, timer, counts } = fixture(() => pending.promise);
    expect(resolver.current()).toBe(plain);
    const first = resolver.resolveSettled();
    const second = resolver.resolveSettled();
    expect(counts().dirtyReads).toBe(1);
    expect(resolver.current()).toBe(plain);
    timer.advanceTime(0);
    expect(counts().dirtyReads).toBe(1);
    pending.resolve({ dirty: true, dirtyHash: "abc123def456" });
    expect(await first).toBe(`${plain}.dirty.abc123def456`);
    expect(await second).toBe(await first);
    expect(await resolver.resolveSettled()).toBe(resolver.current());
    expect(counts()).toEqual({ dirtyReads: 1, versionReads: 1, packageReads: 1 });
  });

  test("isSettled stays false until the due refinement finishes, even when it fails", async () => {
    for (const outcome of ["dirty", "error"] as const) {
      const pending = Promise.withResolvers<GitDirtyState | null>();
      const { resolver } = fixture(() => pending.promise);
      expect(resolver.isSettled()).toBe(false);
      const settled = resolver.resolveSettled();
      expect(resolver.isSettled()).toBe(false);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      if (outcome === "dirty") {
        pending.resolve({ dirty: true, dirtyHash: "abc123def456" });
      } else {
        pending.reject(new Error("git timed out"));
      }
      await settled;
      warn.mockRestore();
      expect(resolver.isSettled()).toBe(true);
    }
  });

  test("isSettled is immediately true when no refinement is due", () => {
    const { resolver } = fixture(undefined, { env: { MCP_SERVER_VERSION: "9.9.9" } });
    expect(resolver.isSettled()).toBe(true);
  });

  test("settlement can be the first read, as in the version-only entrypoint", async () => {
    const { resolver, timer, counts } = fixture();
    expect(await resolver.resolveSettled()).toBe(`${plain}.dirty.abc123def456`);
    expect(counts()).toEqual({ dirtyReads: 1, versionReads: 1, packageReads: 1 });
    timer.advanceTime(0);
    expect(counts().dirtyReads).toBe(1);
  });

  test("settlement joins background refinement already in flight", async () => {
    const pending = Promise.withResolvers<GitDirtyState | null>();
    const { resolver, timer, counts } = fixture(() => pending.promise);
    resolver.current();
    timer.advanceTime(0);
    const settled = resolver.resolveSettled();
    pending.resolve({ dirty: true, dirtyHash: "abc123def456" });
    expect(await settled).toBe(`${plain}.dirty.abc123def456`);
    expect(counts().dirtyReads).toBe(1);
  });

  test("settled identities distinguish different tracked edits at the same HEAD", async () => {
    const first = fixture(async () => ({ dirty: true, dirtyHash: "aaaaaaaaaaaa" }));
    const second = fixture(async () => ({ dirty: true, dirtyHash: "bbbbbbbbbbbb" }));
    expect(first.resolver.current()).toBe(second.resolver.current());
    expect(await first.resolver.resolveSettled()).toBe(`${plain}.dirty.aaaaaaaaaaaa`);
    expect(await second.resolver.resolveSettled()).toBe(`${plain}.dirty.bbbbbbbbbbbb`);
  });

  test.each([
    { env: { MCP_SERVER_VERSION: "9.9.9" } },
    { readGitVersion: () => null },
    { readPackageVersion: () => null },
  ])("settlement needs no timer or dirty read for unstamped versions", async (overrides) => {
    const { resolver, timer, counts } = fixture(undefined, overrides);
    expect(await resolver.resolveSettled()).toBe(resolver.current());
    expect(counts().dirtyReads).toBe(0);
    expect(timer.getPendingTimeouts()).toEqual([]);
  });

  test("first current is plain, then refines after the zero-delay timer and microtasks", async () => {
    const { resolver, timer, counts } = fixture();
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(resolver.current()).toBe(plain);
    expect(counts()).toEqual({ dirtyReads: 0, versionReads: 1, packageReads: 1 });
    expect(timer.getPendingTimeouts()).toEqual([0]);
    timer.advanceTime(0);
    expect(resolver.current()).toBe(plain);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(resolver.current()).toBe(`${plain}.dirty.abc123def456`);
    expect(counts().dirtyReads).toBe(1);
  });

  test.each([{ dirty: false, dirtyHash: null }, null, { dirty: true, dirtyHash: null }])(
    "background result %j preserves or refines the stamp",
    async (state) => {
      const { resolver, timer } = fixture(async () => state);
      expect(resolver.current()).toBe(plain);
      timer.advanceTime(0);
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect(resolver.current()).toBe(state?.dirty ? `${plain}.dirty` : plain);
      expect(await resolver.resolveSettled()).toBe(resolver.current());
    },
  );

  test("a rejected dirty read keeps the plain stamp", async () => {
    const error = new Error("git unavailable");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const { resolver, timer } = fixture(async () => {
      throw error;
    });
    try {
      expect(resolver.current()).toBe(plain);
      timer.advanceTime(0);
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      expect(resolver.current()).toBe(plain);
      expect(timer.getPendingTimeouts()).toEqual([]);
      expect(warning).toHaveBeenCalledWith("Background git dirty-state resolution failed", error);
      expect(await resolver.resolveSettled()).toBe(plain);
    } finally {
      warning.mockRestore();
    }
  });

  test("explicit version override performs no reads or scheduling", () => {
    const { resolver, timer, counts } = fixture(undefined, {
      env: { MCP_SERVER_VERSION: "9.9.9" },
    });
    expect(resolver.current()).toBe("9.9.9");
    expect(resolver.current()).toBe("9.9.9");
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(counts()).toEqual({ dirtyReads: 0, versionReads: 0, packageReads: 0 });
  });

  test("release install schedules nothing", () => {
    const { resolver, timer, counts } = fixture(undefined, { readGitVersion: () => null });
    expect(resolver.current()).toBe("0.0.39");
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(counts().dirtyReads).toBe(0);
  });

  test("unknown version schedules nothing", () => {
    const { resolver, timer, counts } = fixture(undefined, { readPackageVersion: () => null });
    expect(resolver.current()).toBe("unknown");
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(counts().versionReads).toBe(0);
  });

  test("many calls schedule only one refinement and resolve sync inputs once", async () => {
    const { resolver, timer, counts } = fixture();
    for (let i = 0; i < 10; i++) {
      expect(resolver.current()).toBe(plain);
    }
    expect(timer.getPendingTimeouts()).toEqual([0]);
    timer.advanceTime(0);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    for (let i = 0; i < 10; i++) {
      expect(resolver.current()).toBe(`${plain}.dirty.abc123def456`);
    }
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(counts()).toEqual({ dirtyReads: 1, versionReads: 1, packageReads: 1 });
  });

  test("calls during a pending dirty read stay plain without scheduling another read", async () => {
    const pending = Promise.withResolvers<GitDirtyState | null>();
    const { resolver, timer, counts } = fixture(() => pending.promise);
    expect(resolver.current()).toBe(plain);
    timer.advanceTime(0);
    for (let i = 0; i < 10; i++) {
      expect(resolver.current()).toBe(plain);
    }
    expect(counts().dirtyReads).toBe(1);
    expect(timer.getPendingTimeouts()).toEqual([]);
    pending.resolve({ dirty: true, dirtyHash: "abc123def456" });
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(resolver.current()).toBe(`${plain}.dirty.abc123def456`);
  });
});

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

  test("the value persisted into plan files matches the test-plan schema's mcpVersion pattern", () => {
    // PlanSerializer writes releaseVersion(getMcpServerVersion()) so a dev build's
    // `+g<sha>` stamp never reaches the schema gate (^\d+\.\d+\.\d+$), which runs
    // before plan migration could strip it.
    const schemaPattern = /^\d+\.\d+\.\d+$/;
    expect(releaseVersion(getMcpServerVersion())).toMatch(schemaPattern);
    expect(releaseVersion("0.0.39+g1a2b3c4d5e6f.dirty.abc123def456")).toMatch(schemaPattern);
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

  test("appends a bare dirty marker when no diff hash is available", () => {
    expect(formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f", true))).toBe(
      "0.0.39+g1a2b3c4d5e6f.dirty",
    );
  });

  test("includes the tracked-diff hash in the dirty marker when available", () => {
    expect(formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f", true, "abc123def456"))).toBe(
      "0.0.39+g1a2b3c4d5e6f.dirty.abc123def456",
    );
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

  test("two dirty checkouts at the same commit with different edits are distinguished", () => {
    const a = formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f", true, "aaaaaaaaaaaa"));
    const b = formatMcpServerVersion("0.0.39", git("1a2b3c4d5e6f", true, "bbbbbbbbbbbb"));
    expect(a).not.toBe(b);
  });
});

describe("formatMcpServerVersion + the daemon version gate", () => {
  // The stamp is semver build metadata: it makes the *string* vary with the
  // commit (for doctor/logs/DaemonVersionMismatchError diagnostics) while the
  // release portion before `+` stays stable. The version gate compares the
  // release portion for newer/older decisions and treats a same-release/
  // different-stamp difference as a reconcilable dev-skew (restart, not throw).
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
  // Fake git runner and metadata reader keep these tests free of real fs/git.
  // `readName` also makes the ownership check independent of the filesystem.
  const OWN = "@kaeawc/auto-mobile";
  const fakeRun =
    (responses: Record<string, string | null>) =>
    (_cwd: string, args: string[]): string | null => {
      if (args[0] === "rev-parse") {
        return responses.sha?.padEnd(40, "0") ?? null;
      }
      if (args[0] === "status") {
        return responses.status ?? null;
      }
      if (args[0] === "diff") {
        return responses.diff ?? null;
      }
      return null;
    };
  const fakeClient = (responses: Record<string, string | null>) => {
    const run = fakeRun(responses);
    const fs = new FakeGitMetadataReader(
      responses.toplevel
        ? {
            [join(responses.toplevel, ".git")]: null,
            [join(responses.toplevel, ".git/HEAD")]:
              responses.sha?.padEnd(40, "0") ?? "unresolvable",
          }
        : {},
    );
    return new DefaultGitMetadataClient(
      (_command, args, { cwd }) => run(cwd, [...args]),
      fs,
      undefined,
      {},
    );
  };
  const ownsRepo = () => OWN;

  test("returns null for a node_modules location without consulting git (dependency install)", () => {
    let called = false;
    const client = new DefaultGitMetadataClient(() => {
      called = true;
      return null;
    }, new FakeGitMetadataReader());
    expect(
      readGitVersion("/host/node_modules/@kaeawc/auto-mobile/dist", client, ownsRepo),
    ).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null when not inside a git work tree (release install)", () => {
    expect(readGitVersion("/opt/app", fakeClient({ toplevel: null }), ownsRepo)).toBeNull();
  });

  test("returns null when the enclosing repo is a different project (vendored release install)", () => {
    // Repository discovery walks upward; a copy nested in a host repo must not be
    // stamped with the host's commit.
    const client = fakeClient({ toplevel: "/host/repo", sha: "deadbeefcafe" });
    expect(
      readGitVersion("/host/repo/vendor/auto-mobile", client, () => "some-host-app"),
    ).toBeNull();
  });

  test("returns null when HEAD has no resolvable short SHA", () => {
    const client = fakeClient({ toplevel: "/src/auto-mobile", sha: null });
    expect(readGitVersion("/src/auto-mobile", client, ownsRepo)).toBeNull();
  });

  test("stamps a clean checkout of AutoMobile's own repo", () => {
    const client = fakeClient({ toplevel: "/src/auto-mobile", sha: "1a2b3c4d5e6f", status: "" });
    expect(readGitVersion("/src/auto-mobile", client, ownsRepo)).toEqual({
      shortSha: "1a2b3c4d5e6f",
      dirty: false,
      dirtyHash: null,
    });
  });

  test("returns the plain SHA even when the checkout has tracked edits", () => {
    const client = fakeClient({
      toplevel: "/src/auto-mobile",
      sha: "1a2b3c4d5e6f",
      status: " M src/index.ts",
      diff: "diff --git a/src/index.ts b/src/index.ts\n+console.log('a')",
    });
    const result = readGitVersion("/src/auto-mobile", client, ownsRepo);
    expect(result?.shortSha).toBe("1a2b3c4d5e6f");
    expect(result?.dirty).toBe(false);
    expect(result?.dirtyHash).toBeNull();
  });

  test("different dirty diffs do not affect synchronous metadata", () => {
    const base = { toplevel: "/src/auto-mobile", sha: "1a2b3c4d5e6f", status: " M src/index.ts" };
    const a = readGitVersion("/src/auto-mobile", fakeClient({ ...base, diff: "edit A" }), ownsRepo);
    const b = readGitVersion("/src/auto-mobile", fakeClient({ ...base, diff: "edit B" }), ownsRepo);
    expect(a).toEqual(b);
  });

  test("does not inspect an unavailable diff synchronously", () => {
    const client = fakeClient({
      toplevel: "/src/auto-mobile",
      sha: "1a2b3c4d5e6f",
      status: " M x",
      diff: null,
    });
    expect(readGitVersion("/src/auto-mobile", client, ownsRepo)).toEqual({
      shortSha: "1a2b3c4d5e6f",
      dirty: false,
      dirtyHash: null,
    });
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
    expect(resolveMcpServerVersion(deps({ env: { MCP_SERVER_VERSION: "9.9.9" } }))).toBe("9.9.9");
  });

  test("npm_package_version is a fallback when the package manifest is unavailable", () => {
    expect(
      resolveMcpServerVersion(
        deps({
          env: { npm_package_version: "1.2.3" },
          readPackageVersion: () => null,
          readGitVersion: () => git("abcdef123456"),
        }),
      ),
    ).toBe("1.2.3+gabcdef123456");
  });

  test("an installed release ignores an inherited npm package version", () => {
    expect(
      resolveMcpServerVersion(
        deps({
          env: { npm_package_version: "0.0.68" },
          readPackageVersion: () => "0.0.69",
          readGitVersion: () => null,
        }),
      ),
    ).toBe("0.0.69");
  });

  test("a source checkout stamps its manifest version despite an inherited npm version", () => {
    expect(resolveMcpServerVersion(deps({ env: { npm_package_version: "1.2.3" } }))).toBe(
      "0.0.39+g1a2b3c4d5e6f",
    );
  });

  test("package.json version is used as the base and stamped when git is present", () => {
    expect(resolveMcpServerVersion(deps({}))).toBe("0.0.39+g1a2b3c4d5e6f");
  });

  test("returns 'unknown' with no stamp when no base version can be resolved", () => {
    expect(resolveMcpServerVersion(deps({ readPackageVersion: () => null }))).toBe("unknown");
  });

  test("release build (no git) reports the base version unchanged", () => {
    expect(resolveMcpServerVersion(deps({ readGitVersion: () => null }))).toBe("0.0.39");
  });
});
