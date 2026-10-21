// jj-only workspace: tree hashing unsupported; use a colocated checkout. Follow-up required.
import { join } from "node:path";
import { TreeProbe } from "./produceAttestations";
export interface ExecResult {
  code: number;
  stdout: string;
}
export type Exec = (cmd: string, args: string[], cwd?: string) => Promise<ExecResult>;
export type Vcs = "git" | "jj";
export function selectVcs(fsExists: (path: string) => boolean, root: string): Vcs {
  return fsExists(join(root, ".jj")) && !fsExists(join(root, ".git")) ? "jj" : "git";
}
export async function resolveRepositoryRoot(exec: Exec): Promise<string> {
  const git = await exec("git", ["rev-parse", "--show-toplevel"]);
  const result =
    git.code === 0 && git.stdout.trim() ? git : await exec("jj", ["workspace", "root"]);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error("cannot resolve repository root");
  }
  return result.stdout.trim();
}
export class GitTreeProbe implements TreeProbe {
  constructor(
    private readonly vcs: Vcs,
    private readonly exec: Exec,
    private readonly root: string,
  ) {}
  private async run(cmd: string, args: string[]): Promise<string> {
    const result = await this.exec(cmd, args, this.root);
    if (result.code !== 0) {
      throw new Error(`${cmd} ${args.join(" ")} failed (${result.code})`);
    }
    return result.stdout;
  }
  async headId(): Promise<string> {
    return (
      await this.run(
        this.vcs === "git" ? "git" : "jj",
        this.vcs === "git"
          ? ["rev-parse", "HEAD"]
          : ["log", "-r", "@-", "--no-graph", "-T", "commit_id"],
      )
    ).trim();
  }
  async dirtyPaths(paths: readonly string[]): Promise<string[]> {
    const stdout = await this.run(
      this.vcs === "git" ? "git" : "jj",
      this.vcs === "git"
        ? ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]
        : ["diff", "--name-only", "--", ...paths],
    );
    if (this.vcs === "jj") {
      return stdout.split("\n").filter(Boolean);
    }
    const chunks = stdout.split("\0");
    const result: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const record = chunks[i];
      if (!record) {
        continue;
      }
      const path = record.slice(3);
      if (path) {
        result.push(path);
      }
      const status = record.slice(0, 2);
      if ((status.includes("R") || status.includes("C")) && i + 1 < chunks.length) {
        i++;
        if (chunks[i]) {
          result.push(chunks[i]);
        }
      }
    }
    return result;
  }
  async inputEntries(
    paths: readonly string[],
  ): Promise<Array<{ path: string; id: string; mode: string }>> {
    if (this.vcs === "jj") {
      throw new Error("jj-only workspace: tree hashing unsupported; use a colocated checkout");
    }
    const stdout = await this.run("git", ["ls-tree", "-r", "-z", "HEAD", "--", ...paths]);
    return stdout
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t");
        if (tab < 0) {
          throw new Error("invalid git ls-tree record");
        }
        const header = record.slice(0, tab).split(" ");
        return { mode: header[0] ?? "", id: header[2] ?? "", path: record.slice(tab + 1) };
      });
  }
}
