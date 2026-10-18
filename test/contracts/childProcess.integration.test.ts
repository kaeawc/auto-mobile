import { spawn } from "node:child_process";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { runChildProcessContract, type ChildProcessScript } from "./ChildProcessContract";

function nodeScript(script: ChildProcessScript): string {
  return [
    `process.stdout.write(${JSON.stringify(script.stdout ?? "")});`,
    `process.stderr.write(${JSON.stringify(script.stderr ?? "")});`,
    script.hang ? "setInterval(() => {}, 1000);" : `process.exitCode = ${script.exitCode ?? 0};`,
  ].join("");
}

runChildProcessContract("node:child_process spawn", {
  start: (script) => spawn(process.execPath, ["-e", nodeScript(script)]),
  startMissingExecutable: () => spawn("/nonexistent/auto-mobile-contract-binary", []),
});

runChildProcessContract("FakeChildProcess", {
  start: (script) => {
    const child = new FakeChildProcess();
    child.addStdoutData(script.stdout ?? "");
    child.addStderrData(script.stderr ?? "");
    child.simulateSpawn();
    if (!script.hang) {
      child.simulateExit(script.exitCode ?? 0);
    }
    return child;
  },
  startMissingExecutable: () => {
    const child = new FakeChildProcess();
    child.setSpawnError("spawn ENOENT");
    child.simulateSpawn();
    return child;
  },
});
