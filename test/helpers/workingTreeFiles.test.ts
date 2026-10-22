import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type GitListingResult, workingTreeFiles } from "./workingTreeFiles";

const ROOT = "/repo";

function fakeGit(result: GitListingResult, present: readonly string[]) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const onDisk = new Set(present.map((file) => path.join(ROOT, file)));
  return {
    calls,
    deps: {
      runGit: (args: string[], cwd: string) => {
        calls.push({ args, cwd });
        return result;
      },
      exists: (file: string) => onDisk.has(file),
    },
  };
}

describe("workingTreeFiles", () => {
  test("lists tracked and untracked non-ignored files, scoped by pathspec", () => {
    const git = fakeGit({ status: 0, stdout: "docs/a.md\0docs/new.md\0", stderr: "" }, [
      "docs/a.md",
      "docs/new.md",
    ]);
    expect(workingTreeFiles(ROOT, ["*.md"], git.deps)).toEqual(["docs/a.md", "docs/new.md"]);
    expect(git.calls).toEqual([
      {
        args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        cwd: ROOT,
      },
    ]);
  });

  test("drops index entries missing on disk and duplicate conflict stages", () => {
    // An unstaged delete or a sparse/partial checkout leaves the entry in the index only.
    const git = fakeGit(
      { status: 0, stdout: "docs/kept.md\0docs/deleted.md\0docs/kept.md\0", stderr: "" },
      ["docs/kept.md"],
    );
    expect(workingTreeFiles(ROOT, [], git.deps)).toEqual(["docs/kept.md"]);
    expect(git.calls[0]?.args).not.toContain("--");
  });

  test("names the checkout requirement when git cannot list the tree", () => {
    const notARepo = fakeGit(
      { status: 128, stdout: "", stderr: "fatal: not a git repository\n" },
      [],
    );
    expect(() => workingTreeFiles(ROOT, [], notARepo.deps)).toThrow(
      /git ls-files failed in \/repo \(exit 128: fatal: not a git repository\)\. .*git worktree.*jj workspace without a colocated \.git/,
    );
    const missingGit = fakeGit(
      { status: null, stdout: "", stderr: "", error: new Error("spawnSync git ENOENT") },
      [],
    );
    expect(() => workingTreeFiles(ROOT, [], missingGit.deps)).toThrow(
      "git ls-files failed in /repo (spawnSync git ENOENT)",
    );
  });
});
