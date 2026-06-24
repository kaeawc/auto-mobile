import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import process from "process";
import { defaultTimer } from "../../src/utils/SystemTimer";

const repoRoot = resolve(import.meta.dir, "../..");
const VERSION_COMMAND_TIMEOUT_MS = 3_000;

async function runVersionCommand(flag: "--version" | "-v") {
  const proc = Bun.spawn({
    cmd: [process.execPath, "src/index.ts", flag],
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = defaultTimer.setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, VERSION_COMMAND_TIMEOUT_MS);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    return { exitCode, stdout, stderr, timedOut };
  } finally {
    defaultTimer.clearTimeout(timeout);
  }
}

describe("version flag", () => {
  for (const flag of ["--version", "-v"] as const) {
    test(`${flag} prints the package version and exits`, async () => {
      const packageJson = JSON.parse(await Bun.file(resolve(repoRoot, "package.json")).text()) as { version: string };

      const result = await runVersionCommand(flag);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(packageJson.version);
      expect(result.stderr).not.toContain("AutoMobile MCP server running on stdio");
    }, VERSION_COMMAND_TIMEOUT_MS + 1_000);
  }
});
