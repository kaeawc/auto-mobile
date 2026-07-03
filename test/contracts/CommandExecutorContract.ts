import { describe, expect, test } from "bun:test";
import type { HostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import type { ProcessExecutor } from "../../src/utils/ProcessExecutor";

// Real-implementation contract factories spawn a subprocess; forking under CI load
// can stall for seconds, so those cases opt into a generous timeout via timeoutMs.
// Fake-backed factories resolve instantly and leave it undefined (bun's fast default).
export interface ProcessExecutorContractFactory {
  make(): ProcessExecutor;
  command: string;
  timeoutMs?: number;
}

export interface HostCommandExecutorContractFactory {
  make(): HostCommandExecutor;
  file: string;
  args: string[];
  timeoutMs?: number;
}

export const runProcessExecutorContract = (
  description: string,
  factory: ProcessExecutorContractFactory
): void => {
  describe(`ProcessExecutor contract: ${description}`, function() {
    test("exec resolves an ExecResult backed by stdout", async function() {
      const result = await factory.make().exec(factory.command);

      expect(result.stdout.trim()).toBe("contract-output");
      expect(result.stderr).toBe("");
      expect(result.toString().trim()).toBe("contract-output");
      expect(result.trim()).toBe("contract-output");
      expect(result.includes("output")).toBe(true);
    }, factory.timeoutMs);
  });
};

export const runHostCommandExecutorContract = (
  description: string,
  factory: HostCommandExecutorContractFactory
): void => {
  describe(`HostCommandExecutor contract: ${description}`, function() {
    test("executeCommand resolves an ExecResult backed by stdout", async function() {
      const result = await factory.make().executeCommand(factory.file, factory.args);

      expect(result.stdout.trim()).toBe("contract-output");
      expect(result.stderr).toBe("");
      expect(result.toString().trim()).toBe("contract-output");
      expect(result.trim()).toBe("contract-output");
      expect(result.includes("output")).toBe(true);
    }, factory.timeoutMs);
  });
};
