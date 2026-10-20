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

const fixture = (fs = plainRepo(), responses: Record<string, string | null> = {}) => {
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
  const client = new DefaultGitMetadataClient(run, fs);
  return { client, calls, fs, read: (cwd = ROOT) => client.readVersion(cwd, () => OWN) };
};

describe("DefaultGitMetadataClient", () => {
  test("construction performs no git or filesystem reads", () => {
    const { calls, fs } = fixture();
    expect(calls).toEqual([]);
    expect(fs.reads).toEqual([]);
    expect(fs.inspections).toEqual([]);
  });

  test("walks upward to a plain repo and preserves argv and timeout for status", () => {
    const { read, calls } = fixture();
    expect(read(`${ROOT}/src/utils`)).toEqual(CLEAN);
    expect(calls).toEqual([
      { command: "git", args: STATUS, cwd: `${ROOT}/src/utils`, timeoutMs: 2_000 },
    ]);
  });

  test.each([false, true])("spawns before/after: clean 3 -> 1, dirty 4 -> 2 (%s)", (dirty) => {
    const { read, calls } = fixture(plainRepo(), {
      status: dirty ? " M src/index.ts" : "",
      diff: "tracked edit",
    });
    expect(read()?.dirty).toBe(dirty);
    const before = 2 + 1 + Number(dirty); // root + abbreviated SHA + status (+ diff)
    const after = 1 + Number(dirty); // status (+ diff), zero rev-parse on the fast path
    expect(before).toBe(dirty ? 4 : 3);
    expect(calls).toHaveLength(after);
    expect(calls.filter(({ args }) => args[0] === "rev-parse")).toHaveLength(0);
    expect(calls.map(({ args }) => args)).toEqual(dirty ? [STATUS, ["diff", "HEAD"]] : [STATUS]);
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
      expect(calls).toHaveLength(1);
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
    expect(calls).toHaveLength(1);
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
    expect(calls).toHaveLength(1);
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
    expect(calls).toHaveLength(1);
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
    expect(calls).toHaveLength(1);
  });

  test("follows symbolic ref chains, including a packed terminal ref", () => {
    const fs = plainRepo();
    fs.entries[`${ROOT}/.git/refs/heads/main`] = "ref: refs/heads/alias";
    fs.entries[`${ROOT}/.git/packed-refs`] = `${SHA} refs/heads/alias\n`;
    const { read, calls } = fixture(fs);
    expect(read()).toEqual(CLEAN);
    expect(calls).toHaveLength(1);
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
    expect(calls.map(({ args }) => args)).toEqual([["rev-parse", "HEAD"], STATUS]);
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
    expect(calls.map(({ args }) => args)).toEqual([["rev-parse", "HEAD"], STATUS]);
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

  test("re-reads HEAD, status and tracked diff on every call", () => {
    const fs = plainRepo();
    let status = " M src/index.ts";
    let diff = "edit A";
    const recorded: string[][] = [];
    const client = new DefaultGitMetadataClient((_command, args) => {
      recorded.push([...args]);
      return args[0] === "status" ? status : diff;
    }, fs);
    const read = () => client.readVersion(ROOT, () => OWN);
    expect(read()).toEqual({
      shortSha: SHA.slice(0, 12),
      dirty: true,
      dirtyHash: createHash("sha256").update("edit A").digest("hex").slice(0, 12),
    });
    diff = "edit B";
    expect(read()?.dirtyHash).toBe(createHash("sha256").update(diff).digest("hex").slice(0, 12));
    fs.entries[`${ROOT}/.git/refs/heads/main`] = OTHER_SHA;
    status = "";
    expect(read()).toEqual({ ...CLEAN, shortSha: OTHER_SHA.slice(0, 12) });
    expect(recorded).toEqual([STATUS, ["diff", "HEAD"], STATUS, ["diff", "HEAD"], STATUS]);
  });

  test.each([null, ""])("retains a bare dirty marker when diff is unavailable: %s", (diff) => {
    expect(fixture(plainRepo(), { status: " M x", diff }).read()).toEqual({
      ...CLEAN,
      dirty: true,
    });
  });

  test("retains the existing clean fallback when status fails", () => {
    const { read } = fixture(plainRepo(), { status: null });
    expect(read()).toEqual(CLEAN);
  });
});
