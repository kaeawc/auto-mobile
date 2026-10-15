import { appendFile as nodeAppendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AttestationTransport, InputHasher, ShadowRecorder, TierValidators } from "./ports";

export const unconfiguredTransport: AttestationTransport = {
  async fetch() {
    return { kind: "unavailable", reason: "attestation transport not configured (#11981)" };
  },
};
export const failClosedValidators: TierValidators = {};
const execFileAsync = promisify(execFile);
type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
/** Placeholder: tier-specific canonical hashes from #11975/#11976-#11978 replace this adapter. */
export function gitTreeInputHasher(exec: Exec = execFileAsync): InputHasher {
  return {
    async recompute(_tier, repoRoot) {
      const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"]);
      const treeHash = stdout.trim();
      if (!treeHash) {
        throw new Error("empty git tree hash");
      }
      return { treeHash, inputHash: `git-tree:${treeHash}` };
    },
  };
}
export function jsonlFileRecorder(
  path: string,
  appendFile: (path: string, data: string) => Promise<void> = nodeAppendFile,
): ShadowRecorder {
  return {
    async record(entry) {
      await appendFile(path, `${JSON.stringify(entry)}\n`);
    },
  };
}
