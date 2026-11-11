import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { stderrLog } from "../../../src/daemon/manager/DaemonLaunch";
import { isStructuredLoggingEnabled } from "../../../src/utils/logger";

// Verbatim `--cli` auto-restart preamble from #17991 (paths redacted). Callers parse
// the CLI's stdout as the tool JSON, so none of these lines may reach stdout.
const RESTART_PREAMBLE = [
  "Restarting daemon...",
  "Stopping daemon (PID 21024)...",
  "Daemon stopped",
  "Starting AutoMobile daemon...",
  "Launched daemon readiness succeeded after 2749ms (19 polls)",
  "Daemon started successfully (PID 22801, port 3171)",
  "Socket: /tmp/am-l17951b/1/d.sock",
  "Logs: <worktree>/scratch/mt-batch/daemon1/logs/daemon-launch-22641.log",
  "Daemon readiness probe succeeded after 1ms (1 polls; socket observed)",
];

describe("daemon restart notices (#17991)", () => {
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;
  let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, "write">>;
  beforeEach(() => {
    stdout = [];
    stderr = [];
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test("the restart preamble is written to stderr and leaves stdout empty", () => {
    expect(isStructuredLoggingEnabled()).toBe(false);
    for (const line of RESTART_PREAMBLE) {
      stderrLog(line);
    }
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(RESTART_PREAMBLE.map((line) => `${line}\n`));
  });
});
