import { expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import {
  runHostProcessExecutorContract,
  type HostProcessExecutorContractHarness,
} from "./HostProcessExecutorContract";

// DefaultHostCommandExecutor runs against injected exec/child seams so no process starts.
// Its spawn leg is a direct node:child_process call with no seam, so spawn stays out of the
// shared contract and is covered for the fake alone below.
function realHarness(): HostProcessExecutorContractHarness {
  let outcome: { stdout: string; stderr: string } | Error = { stdout: "", stderr: "" };
  const commands: Array<{ file: string; args: string[] }> = [];
  const run = (file: string, args: string[]) => {
    commands.push({ file, args });
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
  const executor = new DefaultHostCommandExecutor(
    async (file, args) => run(file, args),
    (file, args, _options, callback) => {
      // An unspawned ChildProcess is inert: it stands in for the handle without starting anything.
      const child = new ChildProcess();
      queueMicrotask(() => {
        try {
          const { stdout, stderr } = run(file, args);
          callback(null, stdout, stderr);
        } catch (error) {
          callback(error as Error, "", "");
        }
      });
      return child;
    },
  );
  return {
    executor,
    succeedWith: (stdout, stderr) => {
      outcome = { stdout, stderr };
    },
    failWith: (message) => {
      outcome = new Error(message);
    },
    commands: () => commands.map((c) => ({ file: c.file, args: c.args })),
  };
}

function fakeHarness(): HostProcessExecutorContractHarness {
  const executor = new FakeProcessExecutor();
  return {
    executor,
    succeedWith: (stdout, stderr) => {
      executor.setDefaultResponse({
        stdout,
        stderr,
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (s: string) => stdout.includes(s),
      });
    },
    failWith: (message) => executor.setCommandError("", new Error(message)),
    commands: () => executor.getExecutedArgv(),
  };
}

runHostProcessExecutorContract("FakeProcessExecutor", fakeHarness);
runHostProcessExecutorContract("DefaultHostCommandExecutor", realHarness);

test("FakeProcessExecutor.spawn records the request and returns a fake child", () => {
  const executor = new FakeProcessExecutor();

  const child = executor.spawn("server", ["--port", "1"]);

  expect(child).toBeInstanceOf(FakeChildProcess);
  expect(executor.getSpawnedProcesses()).toMatchObject([
    { command: "server", args: ["--port", "1"], process: child },
  ]);
});
