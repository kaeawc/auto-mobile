import { describe, expect, test } from "bun:test";
import type { HostProcessExecutor } from "../../src/utils/HostCommandExecutor";

export interface HostProcessExecutorContractHarness {
  executor: HostProcessExecutor;
  /** Scripts what every later command run prints. */
  succeedWith(stdout: string, stderr: string): void;
  /** Scripts every later command run to fail with this message. */
  failWith(message: string): void;
  /** The file and argv of each command run through the executor, in order. */
  commands(): Array<{ file: string; args: string[] }>;
}

/**
 * Shared contract for every {@link HostProcessExecutor}: argv-first commands resolve a
 * coerced ExecResult or reject with the command line, executeCommandWithChild exposes the
 * child beside the same result, and spawn (not covered: the real one launches an actual process with no seam). Run against
 * DefaultHostCommandExecutor (injected exec seams, no real process) and FakeProcessExecutor
 * (issue #11868).
 */
export const runHostProcessExecutorContract = (
  description: string,
  make: () => HostProcessExecutorContractHarness,
): void => {
  describe(`HostProcessExecutor contract: ${description}`, function () {
    test("resolves stdout and stderr with ExecResult helpers", async function () {
      const { executor, succeedWith, commands } = make();
      succeedWith("  hello world\n", "warn");

      const result = await executor.executeCommand("echo", ["hello", "two words"]);

      expect(result.stdout).toBe("  hello world\n");
      expect(result.stderr).toBe("warn");
      expect(result.trim()).toBe("hello world");
      expect(result.includes("world")).toBe(true);
      expect(result.includes("absent")).toBe(false);
      expect(result.toString()).toBe("  hello world\n");
      expect(commands()).toEqual([{ file: "echo", args: ["hello", "two words"] }]);
    });

    test("defaults to an empty argv", async function () {
      const { executor, commands } = make();

      await executor.executeCommand("uname");

      expect(commands()).toEqual([{ file: "uname", args: [] }]);
    });

    test("rejects with the failed command line when the command fails", async function () {
      const { executor, failWith } = make();
      failWith("exit 1");

      const failure = await executor.executeCommand("adb", ["devices"]).then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain("Command failed: adb devices");
      expect(failure?.message).toContain("exit 1");
    });

    test("executeCommandWithChild exposes the child beside the command result", async function () {
      const { executor, succeedWith } = make();
      succeedWith("ok", "");

      const started = executor.executeCommandWithChild("tool", ["--flag"]);
      const result = await started.result;

      expect(started.child).toBeDefined();
      expect(typeof started.child.on).toBe("function");
      expect(result.stdout).toBe("ok");
    });

    test("executeCommandWithChild rejects the result with the command line on failure", async function () {
      const { executor, failWith } = make();
      failWith("boom");

      const started = executor.executeCommandWithChild("tool", ["--flag"]);
      const failure = await started.result.then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      expect(started.child).toBeDefined();
      expect(failure?.message).toContain("Command failed: tool --flag");
    });
  });
};
