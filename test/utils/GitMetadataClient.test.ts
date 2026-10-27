import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DefaultGitMetadataClient, type GitCommandRunner } from "../../src/utils/GitMetadataClient";
import { FakeGitMetadataReader } from "../fakes/FakeFileSystem";

const OWN = "@kaeawc/auto-mobile";
const ROOT = "/src/auto-mobile";
const SHA = "1a2b3c4d5e6f7890123456789012345678901234";
const OTHER_SHA = "abcdef1234567890123456789012345678901234";
const STATUS = ["status", "--porcelain", "--untracked-files=no"];
const CLEAN = { shortSha: SHA.slice(0, 12), dirty: false, dirtyHash: null };
const plainRepo = () =>
  new FakeGitMetadataReader({
    [`${ROOT}/.git`]: null,
    [`${ROOT}/.git/HEAD`]: "ref: refs/heads/main\n",
    [`${ROOT}/.git/refs/heads/main`]: `${SHA}\n`,
  });

const fixture = (
  fs = plainRepo(),
  responses: Record<string, string | null> = {},
  env: NodeJS.ProcessEnv = {},
) => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string; timeoutMs: number }> =
    [];
  const run: GitCommandRunner = (command, args, options) => {
    calls.push({ command, args, ...options });
    if (args[0] === "rev-parse") {
      if (args[1] === "--show-toplevel") {
        return ROOT;
      }
      const sha = Object.hasOwn(responses, "sha") ? responses.sha : SHA;
      return args[1] === "--short=12" ? (sha?.slice(0, 12) ?? null) : sha;
    }
    return Object.hasOwn(responses, args[0])
      ? responses[args[0]]
      : args[0] === "status"
        ? ""
        : null;
  };
  const client = new DefaultGitMetadataClient(run, fs, async (...args) => run(...args), env);
  const roots: string[] = [];
  const read = (cwd = ROOT) =>
    client.readVersion(cwd, (root) => {
      roots.push(root);
      return OWN;
    });
  return { client, calls, fs, roots, read };
};

describe("DefaultGitMetadataClient", () => {
  test("construction performs no git or filesystem reads", () => {
    const { calls, fs } = fixture();
    expect(calls).toEqual([]);
    expect(fs.reads).toEqual([]);
    expect(fs.inspections).toEqual([]);
  });

  test("walks upward to a plain repo without spawning", () => {
    const { read, calls } = fixture();
    expect(read(`${ROOT}/src/utils`)).toEqual(CLEAN);
    expect(calls).toEqual([]);
  });

  test.each([false, true])("readVersion never spawns status/diff (dirty: %s)", (dirty) => {
    const { read, calls } = fixture(plainRepo(), {
      status: dirty ? " M src/index.ts" : "",
      diff: "tracked edit",
    });
    expect(read()).toEqual(CLEAN);
    expect(calls).toEqual([]);
  });

  test.each(["/repo/.git/worktrees/lane", "../../repo/.git/worktrees/lane"])(
    "reads a linked worktree's common loose refs via gitdir: %s",
    (gitdir) => {
      const fs = new FakeGitMetadataReader({
        [`${ROOT}/.git`]: `gitdir: ${gitdir}\n`,
        "/repo/.git/worktrees/lane/HEAD": "ref: refs/heads/main\n",
        "/repo/.git/worktrees/lane/commondir": "../..\n",
        "/repo/.git/refs/heads/main": SHA,
        // Ordinary refs belong to the common dir, even if a stale local copy exists.
        "/repo/.git/worktrees/lane/refs/heads/main": OTHER_SHA,
      });
      const { read, calls } = fixture(fs);
      expect(read()).toEqual(CLEAN);
      expect(calls).toHaveLength(0);
    },
  );

  test.each(["space dir", "trailing "])("preserves spaces in gitdir and commondir: %s", (name) => {
    const gitdir = `/repo/${name}`;
    const common = `/common/${name}`;
    const { read, calls } = fixture(
      new FakeGitMetadataReader({
        [`${ROOT}/.git`]: `gitdir: ${gitdir}\n`,
        [`${gitdir}/HEAD`]: "ref: refs/heads/main\n",
        [`${gitdir}/commondir`]: `${common}\n`,
        [`${common}/refs/heads/main`]: SHA,
      }),
    );
    expect(read()).toEqual(CLEAN);
    expect(calls).toHaveLength(0);
  });

  test("reads a submodule gitfile without commondir", () => {
    const { read, calls } = fixture(
      new FakeGitMetadataReader({
        [`${ROOT}/.git`]: "gitdir: /repo/.git/modules/sub\n",
        "/repo/.git/modules/sub/HEAD": "ref: refs/heads/main",
        "/repo/.git/modules/sub/refs/heads/main": SHA,
      }),
    );
    expect(read()).toEqual(CLEAN);
    expect(calls).toHaveLength(0);
  });

  test.each([false, true])("reads packed-only refs (linked worktree: %s)", (linked) => {
    const fs = plainRepo();
    delete fs.entries[`${ROOT}/.git/refs/heads/main`];
    const common = linked ? "/common" : `${ROOT}/.git`;
    if (linked) {
      fs.entries[`${ROOT}/.git/commondir`] = common;
    }
    fs.entries[`${common}/packed-refs`] =
      `# pack-refs with: peeled fully-peeled sorted\n${OTHER_SHA} refs/tags/v1\n^${SHA}\n${SHA} refs/heads/main\n`;
    const { read, calls } = fixture(fs);
    expect(read()).toEqual(CLEAN);
    expect(calls).toHaveLength(0);
  });

  test("prefers loose refs over packed refs", () => {
    const fs = plainRepo();
    fs.entries[`${ROOT}/.git/packed-refs`] = `${OTHER_SHA} refs/heads/main\n`;
    expect(fixture(fs).read()).toEqual(CLEAN);
  });

  test.each([SHA, "a".repeat(64)])("accepts detached full HEAD: %s", (sha) => {
    const fs = plainRepo();
    fs.entries[`${ROOT}/.git/HEAD`] = `${sha}\n`;
    const { read, calls } = fixture(fs);
    expect(read()).toEqual({ ...CLEAN, shortSha: sha.slice(0, 12) });
    expect(calls).toHaveLength(0);
  });

  test("follows symbolic ref chains, including a packed terminal ref", () => {
    const fs = plainRepo();
    fs.entries[`${ROOT}/.git/refs/heads/main`] = "ref: refs/heads/alias";
    fs.entries[`${ROOT}/.git/packed-refs`] = `${SHA} refs/heads/alias\n`;
    const { read, calls } = fixture(fs);
    expect(read()).toEqual(CLEAN);
    expect(calls).toHaveLength(0);
  });

  test("resolves worktree-private refs in the worktree gitdir", () => {
    const fs = plainRepo();
    fs.entries[`${ROOT}/.git/commondir`] = "/common";
    fs.entries[`${ROOT}/.git/HEAD`] = "ref: refs/bisect/good";
    fs.entries[`${ROOT}/.git/refs/bisect/good`] = SHA;
    fs.entries["/common/refs/bisect/good"] = OTHER_SHA;
    expect(fixture(fs).read()).toEqual(CLEAN);
  });

  test.each([
    ["reftable", "ref: refs/heads/missing"],
    ["unresolvable", "ref: refs/heads/missing"],
    ["cycle", "ref: refs/heads/main"],
    ["malformed HEAD", "not a sha"],
    ["path traversal", "ref: refs/../../outside"],
    ["malformed loose ref", "ref: refs/heads/main"],
    ["malformed packed ref", "ref: refs/heads/missing"],
    ["malformed gitfile", "ref: refs/heads/main"],
    ["malformed commondir", "ref: refs/heads/main"],
  ])("falls back to full rev-parse HEAD for %s", (scenario, head) => {
    const fs = plainRepo();
    fs.entries[`${ROOT}/.git/HEAD`] = head;
    if (scenario === "reftable") {
      fs.entries[`${ROOT}/.git/reftable`] = null;
      fs.entries[`${ROOT}/.git/refs/heads/missing`] = OTHER_SHA;
    } else if (scenario === "cycle") {
      fs.entries[`${ROOT}/.git/refs/heads/main`] = "ref: refs/heads/main";
    } else if (scenario === "malformed loose ref") {
      fs.entries[`${ROOT}/.git/refs/heads/main`] = "bad";
    } else if (scenario === "malformed packed ref") {
      fs.entries[`${ROOT}/.git/packed-refs`] = "bad refs/heads/missing";
    } else if (scenario === "malformed gitfile") {
      fs.entries[`${ROOT}/.git`] = "unexpected";
    } else if (scenario === "malformed commondir") {
      fs.entries[`${ROOT}/.git/commondir`] = "\n";
    }
    const { read, calls } = fixture(fs, { sha: SHA });
    expect(read()).toEqual(CLEAN);
    expect(calls).toEqual([
      { command: "git", args: ["rev-parse", "HEAD"], cwd: ROOT, timeoutMs: 2_000 },
    ]);
  });

  test("filesystem read errors fall back before logger initialization", () => {
    class UnreadableGitMetadataReader extends FakeGitMetadataReader {
      override readFile(): string | null {
        throw new Error("unreadable metadata");
      }
    }
    const fs = new UnreadableGitMetadataReader(plainRepo().entries);
    const { read, calls } = fixture(fs, { sha: SHA });
    expect(read()).toEqual(CLEAN);
    expect(calls.map(({ args }) => args)).toEqual([["rev-parse", "HEAD"]]);
  });

  test("returns null when fallback git is missing, times out, or cannot resolve HEAD", () => {
    const fs = plainRepo();
    delete fs.entries[`${ROOT}/.git/HEAD`];
    const { read, calls } = fixture(fs, { sha: null });
    expect(read()).toBeNull();
    expect(calls.map(({ args }) => args)).toEqual([["rev-parse", "HEAD"]]);
  });

  test("returns null for a non-repository without spawning", () => {
    const { read, calls } = fixture(new FakeGitMetadataReader());
    expect(read("/opt/app")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("returns null without reads or spawns from node_modules", () => {
    const { read, calls, fs } = fixture();
    expect(read("/host/node_modules/@kaeawc/auto-mobile/dist")).toBeNull();
    expect(calls).toEqual([]);
    expect(fs.reads).toEqual([]);
  });

  test("checks the enclosing root's package name before reading HEAD or spawning", () => {
    const { client, calls, fs } = fixture();
    const roots: string[] = [];
    expect(
      client.readVersion(`${ROOT}/vendor/auto-mobile`, (root) => {
        roots.push(root);
        return "some-host-app";
      }),
    ).toBeNull();
    expect(roots).toEqual([resolve(ROOT)]);
    expect(calls).toEqual([]);
    expect(fs.reads).toEqual([]);
  });

  test("re-reads HEAD on every synchronous call without spawning", () => {
    const { read, calls, fs } = fixture();
    expect(read()).toEqual(CLEAN);
    fs.entries[`${ROOT}/.git/refs/heads/main`] = OTHER_SHA;
    expect(read()).toEqual({ ...CLEAN, shortSha: OTHER_SHA.slice(0, 12) });
    expect(calls).toEqual([]);
  });

  test("re-reads status and tracked diff on every async call", async () => {
    const fs = plainRepo();
    let status = " M src/index.ts";
    let diff = "edit A";
    const recorded: string[][] = [];
    const client = new DefaultGitMetadataClient(
      () => {
        throw new Error("unexpected sync git");
      },
      fs,
      async (_command, args) => {
        recorded.push([...args]);
        return args[0] === "status" ? status : diff;
      },
      {},
    );
    const read = () => client.readDirtyState(ROOT);
    expect(await read()).toEqual({
      dirty: true,
      dirtyHash: createHash("sha256").update("edit A").digest("hex").slice(0, 12),
    });
    diff = "edit B";
    expect((await read())?.dirtyHash).toBe(
      createHash("sha256").update(diff).digest("hex").slice(0, 12),
    );
    status = "";
    expect(await read()).toEqual({ dirty: false, dirtyHash: null });
    expect(recorded).toEqual([STATUS, ["diff", "HEAD"], STATUS, ["diff", "HEAD"], STATUS]);
  });

  test("async probes preserve argv, cwd and timeout", async () => {
    const { client, calls } = fixture(plainRepo(), { status: " M x", diff: "edit" });
    expect(await client.readDirtyState(`${ROOT}/src/utils`)).toEqual({
      dirty: true,
      dirtyHash: createHash("sha256").update("edit").digest("hex").slice(0, 12),
    });
    expect(calls).toEqual([
      { command: "git", args: STATUS, cwd: `${ROOT}/src/utils`, timeoutMs: 2_000 },
      { command: "git", args: ["diff", "HEAD"], cwd: `${ROOT}/src/utils`, timeoutMs: 2_000 },
    ]);
  });

  test.each([null, ""])(
    "retains a bare dirty marker when diff is unavailable: %s",
    async (diff) => {
      expect(
        await fixture(plainRepo(), { status: " M x", diff }).client.readDirtyState(ROOT),
      ).toEqual({
        dirty: true,
        dirtyHash: null,
      });
    },
  );

  test.each([null, ""])(
    "status %s skips diff and returns failure or clean state",
    async (status) => {
      const { client, calls } = fixture(plainRepo(), { status });
      expect(await client.readDirtyState(ROOT)).toEqual(
        status === null ? null : { dirty: false, dirtyHash: null },
      );
      expect(calls.map(({ args }) => args)).toEqual([STATUS]);
    },
  );

  describe("repository environment overrides (#14506)", () => {
    const WORK = "/work/tree";
    // A separate work tree exposed via GIT_DIR has no .git marker of its own.
    const envRepo = (entries: Record<string, string | null> = {}) =>
      new FakeGitMetadataReader({
        "/repos/am.git": null,
        "/repos/am.git/HEAD": "ref: refs/heads/main\n",
        "/repos/am.git/refs/heads/main": `${SHA}\n`,
        ...entries,
      });

    test("honours GIT_DIR and GIT_WORK_TREE without a .git marker, resolved from cwd", () => {
      const { read, calls, roots } = fixture(
        envRepo(),
        {},
        {
          GIT_DIR: "../../../repos/am.git",
          GIT_WORK_TREE: "..",
        },
      );
      expect(read(`${WORK}/src`)).toEqual(CLEAN);
      expect(roots).toEqual([resolve(WORK)]);
      expect(calls).toEqual([]);
    });

    test("never mixes a physical checkout's HEAD with GIT_DIR-scoped probes", () => {
      const fs = envRepo({
        [`${WORK}/.git`]: null,
        [`${WORK}/.git/HEAD`]: `${OTHER_SHA}\n`,
      });
      const { read, calls } = fixture(fs, {}, { GIT_DIR: "/repos/am.git", GIT_WORK_TREE: WORK });
      expect(read(WORK)).toEqual(CLEAN);
      expect(calls).toEqual([]);
      expect(fs.reads).not.toContain(`${WORK}/.git/HEAD`);
    });

    test("asks git for the work tree when only GIT_DIR is set", () => {
      const { read, calls, roots } = fixture(envRepo(), {}, { GIT_DIR: "/repos/am.git" });
      expect(read(WORK)).toEqual(CLEAN);
      expect(roots).toEqual([ROOT]);
      expect(calls).toEqual([
        { command: "git", args: ["rev-parse", "--show-toplevel"], cwd: WORK, timeoutMs: 2_000 },
      ]);
    });

    test("follows a GIT_DIR gitfile and a GIT_COMMON_DIR override", () => {
      const fs = new FakeGitMetadataReader({
        "/repos/link": "gitdir: lane\n",
        "/repos/lane/HEAD": "ref: refs/heads/main\n",
        "/repos/lane/commondir": "/ignored\n",
        "/ignored/refs/heads/main": OTHER_SHA,
        "/common/refs/heads/main": SHA,
      });
      const { read, calls } = fixture(
        fs,
        {},
        {
          GIT_DIR: "/repos/link",
          GIT_WORK_TREE: WORK,
          GIT_COMMON_DIR: "../../common",
        },
      );
      expect(read(WORK)).toEqual(CLEAN);
      expect(calls).toEqual([]);
    });

    test("GIT_WORK_TREE alone keeps discovery but checks the work tree's package", () => {
      const { client, calls } = fixture(plainRepo(), {}, { GIT_WORK_TREE: WORK });
      const roots: string[] = [];
      expect(
        client.readVersion(`${ROOT}/src`, (root) => {
          roots.push(root);
          return "some-host-app";
        }),
      ).toBeNull();
      expect(roots).toEqual([resolve(WORK)]);
      expect(calls).toEqual([]);
    });

    test("falls back to rev-parse HEAD in the same environment when GIT_DIR HEAD is unreadable", () => {
      const fs = envRepo({ "/repos/am.git/HEAD": "unresolvable" });
      const { read, calls } = fixture(fs, {}, { GIT_DIR: "/repos/am.git", GIT_WORK_TREE: WORK });
      expect(read(WORK)).toEqual(CLEAN);
      expect(calls.map(({ args, cwd }) => [args, cwd])).toEqual([[["rev-parse", "HEAD"], WORK]]);
    });

    test("returns null when GIT_DIR names no repository, ignoring a physical checkout", () => {
      const { read, calls } = fixture(
        plainRepo(),
        { sha: null },
        {
          GIT_DIR: "/missing.git",
          GIT_WORK_TREE: ROOT,
        },
      );
      expect(read()).toBeNull();
      expect(calls.map(({ args }) => args)).toEqual([["rev-parse", "HEAD"]]);
    });

    test.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"])(
      "delegates an empty %s to git instead of reading the physical checkout",
      (name) => {
        const { read, calls, fs } = fixture(plainRepo(), { sha: null }, { [name]: "" });
        expect(read()).toBeNull();
        expect(calls.map(({ args }) => args)).toEqual([
          ["rev-parse", "--show-toplevel"],
          ["rev-parse", "HEAD"],
        ]);
        expect(fs.reads).toEqual([]);
      },
    );
  });
});
