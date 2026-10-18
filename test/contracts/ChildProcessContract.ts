import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** The slice of a spawned child the contract exercises. */
export type ContractChild = Pick<
  ChildProcessWithoutNullStreams,
  "stdout" | "stderr" | "pid" | "exitCode" | "killed" | "kill" | "on" | "once"
>;

export interface ChildProcessScript {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Stays alive, only ending when killed. */
  hang?: boolean;
}

export interface ChildProcessContractHarness {
  /** Starts a child that prints the script's output and exits (or hangs) as scripted. */
  start(script: ChildProcessScript): ContractChild;
  /** Starts a child whose executable does not exist. */
  startMissingExecutable(): ContractChild;
}

interface Observed {
  events: string[];
  stdout: string;
  stderr: string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function observe(child: ContractChild): Observed {
  const observed: Observed = {
    events: [],
    stdout: "",
    stderr: "",
    closed: Promise.resolve({ code: null, signal: null }),
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (observed.stdout += chunk));
  child.stderr.on("data", (chunk: string) => (observed.stderr += chunk));
  child.on("spawn", () => observed.events.push("spawn"));
  child.on("exit", () => observed.events.push("exit"));
  observed.closed = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      observed.events.push("close");
      resolve({ code, signal });
    });
  });
  return observed;
}

/**
 * Shared contract for the child process handle spawn consumers rely on: spawn, then output,
 * then exit before close, the exit code on the handle, kill semantics (the child ends by signal with no exit
 * code; kill's return after exit is runtime-specific, true under bun and false under node, so it is
 * not asserted) and a missing executable surfacing as an error
 * event with no pid. Run against node:child_process spawn of process.execPath and
 * FakeChildProcess (issue #11868).
 */
export const runChildProcessContract = (
  description: string,
  harness: ChildProcessContractHarness,
  timeoutMs = 5_000,
): void => {
  describe(`ChildProcess contract: ${description}`, function () {
    test(
      "reports spawn, output, then exit before close with the exit code",
      async function () {
        const child = harness.start({ stdout: "out", stderr: "err", exitCode: 3 });
        const observed = observe(child);

        const { code, signal } = await observed.closed;

        expect(observed.events).toEqual(["spawn", "exit", "close"]);
        expect(observed.stdout).toBe("out");
        expect(observed.stderr).toBe("err");
        expect(code).toBe(3);
        expect(signal).toBeNull();
        expect(child.exitCode).toBe(3);
        expect(child.killed).toBe(false);
        expect(typeof child.pid).toBe("number");
      },
      timeoutMs,
    );

    test(
      "kills a running child once and ends it by signal without an exit code",
      async function () {
        const child = harness.start({ hang: true });
        const observed = observe(child);
        await new Promise((resolve) => child.once("spawn", resolve));

        expect(child.kill("SIGTERM")).toBe(true);
        expect(child.killed).toBe(true);
        const { code, signal } = await observed.closed;

        expect(code).toBeNull();
        expect(signal).toBe("SIGTERM");
        expect(child.exitCode).toBeNull();
        expect(observed.events).toEqual(["spawn", "exit", "close"]);
      },
      timeoutMs,
    );

    test(
      "emits an error and has no pid when the executable is missing",
      async function () {
        const child = harness.startMissingExecutable();

        const error = await new Promise<Error>((resolve) => child.once("error", resolve));

        expect(error).toBeInstanceOf(Error);
        expect(child.pid).toBeUndefined();
      },
      timeoutMs,
    );
  });
};
