import { describe, expect, test } from "bun:test";
import {
  Exec,
  GitTreeProbe,
  resolveRepositoryRoot,
  selectVcs,
} from "../../../scripts/ci/attestation/gitTreeProbe";
describe("git tree probe", () => {
  test("parses NUL porcelain and ls-tree paths with spaces", async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return {
        code: 0,
        stdout:
          args[0] === "status"
            ? "?? src/new file.ts\0 M src/changed file.ts\0R  src/new.ts\0src/old.ts\0"
            : "100644 blob abc123\tsrc/file name.ts\0",
      };
    };
    const probe = new GitTreeProbe("git", exec, "/repo");
    expect(await probe.dirtyPaths(["src"])).toEqual([
      "src/new file.ts",
      "src/changed file.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
    expect(await probe.inputEntries(["src"])).toEqual([
      { path: "src/file name.ts", mode: "100644", id: "abc123" },
    ]);
    expect(calls).toHaveLength(2);
  });
  test("selects jj-only workspaces and reports unsupported tree hashing", async () => {
    expect(selectVcs((path) => path === "/repo/.jj", "/repo")).toBe("jj");
    const probe = new GitTreeProbe(
      "jj",
      async (_cmd, args) => ({
        code: 0,
        stdout: args[0] === "diff" ? "src/file.ts\n" : "treeid",
      }),
      "/repo",
    );
    expect(await probe.dirtyPaths(["src"])).toEqual(["src/file.ts"]);
    expect(await probe.headId()).toBe("treeid");
    await expect(probe.inputEntries(["src"])).rejects.toThrow(
      "jj-only workspace: tree hashing unsupported; use a colocated checkout",
    );
  });
});

test("resolves root from subdirectory and executes every probe command there", async () => {
  const cwds: Array<string | undefined> = [];
  const exec: Exec = async (_cmd, args, cwd) => {
    if (args[1] === "--show-toplevel") {
      expect(cwd).toBeUndefined(); // Discovery inherits the caller's ios/XCTestRunner cwd.
      return { code: 0, stdout: "/repo\n" };
    }
    cwds.push(cwd);
    expect(cwd).toBe("/repo");
    if (args[0] === "status") {
      expect(args.slice(-1)).toEqual(["ios"]);
      return { code: 0, stdout: " M ios/a.swift\0" };
    }
    return { code: 0, stdout: args[0] === "ls-tree" ? "100755 blob abc\tios/a.swift\0" : "head" };
  };
  const root = await resolveRepositoryRoot(exec);
  const probe = new GitTreeProbe(
    selectVcs((path) => path === "/repo/.git", root),
    exec,
    root,
  );
  expect(await probe.headId()).toBe("head");
  expect(await probe.dirtyPaths(["ios"])).toEqual(["ios/a.swift"]);
  expect(await probe.inputEntries(["ios"])).toEqual([
    { path: "ios/a.swift", id: "abc", mode: "100755" },
  ]);
  expect(cwds).toEqual(["/repo", "/repo", "/repo"]);
});
