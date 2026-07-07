import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPPORTED_INPUT_KEYS } from "../../src/features/action/InputKey";

const repoRoot = join(import.meta.dir, "../..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf-8");
}

describe("daemon input/key contract docs", () => {
  test("documents every supported key name in the daemon Unix socket API", async () => {
    const unixSocketDoc = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    expect(unixSocketDoc).toContain("### `input/key`");
    expect(unixSocketDoc).toContain("Modifiers are not supported");
    for (const key of SUPPORTED_INPUT_KEYS) {
      expect(unixSocketDoc).toContain(`\`${key}\``);
    }
  });
});
