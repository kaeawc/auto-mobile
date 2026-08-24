import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultGitMetadataClient, type GitCommandRunner } from "../../src/utils/GitMetadataClient";

const OWN = "@kaeawc/auto-mobile";

const fakeRunner =
  (responses: Record<string, string | null>): GitCommandRunner =>
  (_command, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return responses.toplevel ?? null;
    }
    if (args[0] === "rev-parse" && args[1] === "--short=12") {
      return responses.sha ?? null;
    }
    if (args[0] === "status") {
      return responses.status ?? null;
    }
    if (args[0] === "diff") {
      return responses.diff ?? null;
    }
    return null;
  };

describe("DefaultGitMetadataClient", () => {
  // Git for Windows is commonly a shell-resolved git.exe shim, while this
  // production boundary deliberately uses shell:false argv execution. A jj
  // workspace has no Git worktree, so its optional Git metadata is expected
  // to be unavailable and is covered by the injected-runner tests below.
  test.skipIf(process.platform === "win32" || !existsSync(".git"))(
    "uses the default runner in this Git source checkout",
    () => {
      const readPackageName = (directory: string): string | null =>
        (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: string })
          .name ?? null;

      expect(
        new DefaultGitMetadataClient().readVersion(process.cwd(), readPackageName)?.shortSha,
      ).toMatch(/^[0-9a-f]{12}$/);
    },
  );

  test("uses argv and a short timeout when executing git", () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
      timeoutMs: number;
    }> = [];
    const client = new DefaultGitMetadataClient((command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, timeoutMs: options.timeoutMs });
      if (args[1] === "--show-toplevel") {
        return "/src/auto-mobile";
      }
      if (args[1] === "--short=12") {
        return "1a2b3c4d5e6f";
      }
      return "";
    });

    expect(client.readVersion("/src/auto-mobile", () => OWN)).toMatchObject({
      shortSha: "1a2b3c4d5e6f",
    });
    expect(calls).toContainEqual({
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: "/src/auto-mobile",
      timeoutMs: 2_000,
    });
  });

  test("returns null without executing git from a dependency install", () => {
    let called = false;
    const client = new DefaultGitMetadataClient(() => {
      called = true;
      return null;
    });

    expect(client.readVersion("/host/node_modules/@kaeawc/auto-mobile/dist", () => OWN)).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null for a non-repository, missing git, or timed-out command", () => {
    for (const result of [null, null, null]) {
      const client = new DefaultGitMetadataClient(() => result);
      expect(client.readVersion("/opt/app", () => OWN)).toBeNull();
    }
  });

  test("accepts detached HEAD because revision probing does not require a branch", () => {
    const client = new DefaultGitMetadataClient(
      fakeRunner({
        toplevel: "/src/auto-mobile",
        sha: "1a2b3c4d5e6f",
        status: "",
      }),
    );

    expect(client.readVersion("/src/auto-mobile", () => OWN)).toEqual({
      shortSha: "1a2b3c4d5e6f",
      dirty: false,
      dirtyHash: null,
    });
  });

  test("returns null when the repository root is not AutoMobile", () => {
    const client = new DefaultGitMetadataClient(
      fakeRunner({ toplevel: "/host/repo", sha: "deadbeefcafe" }),
    );

    expect(client.readVersion("/host/repo/vendor/auto-mobile", () => "some-host-app")).toBeNull();
  });
});
