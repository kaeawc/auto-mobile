import { describe, expect, test } from "bun:test";
import type { HostCommandExecutor } from "../../src/utils/HostCommandExecutor";

export interface HostCommandExecutorContractFactory {
  make(): HostCommandExecutor;
  file: string;
  args: string[];
  timeoutMs?: number;
}

export const runHostCommandExecutorContract = (
  description: string,
  factory: HostCommandExecutorContractFactory,
): void => {
  describe(`HostCommandExecutor contract: ${description}`, function () {
    test(
      "executeCommand resolves an ExecResult backed by stdout",
      async function () {
        const result = await factory.make().executeCommand(factory.file, factory.args);

        expect(result.stdout.trim()).toBe("contract-output");
        expect(result.stderr).toBe("");
        expect(result.toString().trim()).toBe("contract-output");
        expect(result.trim()).toBe("contract-output");
        expect(result.includes("output")).toBe(true);
      },
      factory.timeoutMs,
    );
  });
};
