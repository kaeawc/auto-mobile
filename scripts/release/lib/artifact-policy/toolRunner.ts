import { execFile } from "node:child_process";

export interface ToolResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Narrow seam over host tools (aapt2, plutil, codesign, nm); fakes replay captured output. */
export interface ToolRunner {
  run(command: string, args: readonly string[], stdin?: string): Promise<ToolResult>;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Runs the real tool and rejects with the tool's stderr when it exits non-zero. */
export class ExecFileToolRunner implements ToolRunner {
  run(command: string, args: readonly string[], stdin?: string): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        [...args],
        { maxBuffer: MAX_OUTPUT_BYTES, timeout: DEFAULT_TIMEOUT_MS, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      child.stdin?.end(stdin ?? "");
    });
  }
}
