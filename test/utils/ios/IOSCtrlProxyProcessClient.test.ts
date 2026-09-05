import { describe, expect, test } from "bun:test";
import { IOSCtrlProxyProcessClient } from "../../../src/utils/ios/IOSCtrlProxyProcessClient";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

function result(stdout = "", stderr = "") {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text: string) => stdout.includes(text),
  };
}

describe("IOSCtrlProxyProcessClient", () => {
  test("bounds startup candidate discovery by the supplied deadline", async () => {
    const timer = new FakeTimer();
    const options: Array<HostCommandOptions | undefined> = [];
    const host: HostCommandExecutor = {
      async executeCommand(_file, _args, commandOptions) {
        options.push(commandOptions);
        return result();
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, timer);

    await client.findStartupCandidatePids(100);

    expect(options).toEqual([{ timeoutMs: 100 }]);
  });

  test("uses argv for PID lookup and preserves device identity validation", async () => {
    const host = new FakeHostCommandExecutor();
    host.setCommandResponse("pgrep -x xcodebuild", result("42\n"));
    host.setCommandResponse(
      "ps -p 42 -o ppid= -o args=",
      result(
        "2 xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=DEVICE-1 -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
      ),
    );
    host.setCommandResponse("ps eww -p 42 -o command=", result("AUTOMOBILE_DEVICE_ID=DEVICE-1"));
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());

    const process = await client.findExternalXcodebuildCtrlProxyProcess("DEVICE-1");

    expect(process).toEqual({ pid: 42, port: 8765 });
    expect(host.getExecutedCommands()).toContain("pgrep -x xcodebuild");
    expect(host.getExecutedCommands()).toContain("ps -p 42 -o ppid= -o args=");
  });

  test("does not identify a recycled PID as a CtrlProxy runner", async () => {
    const host = new FakeHostCommandExecutor();
    host.setCommandResponse("kill -0 42", result());
    host.setCommandResponse(
      "ps -p 42 -o ppid= -o args=",
      result("1 xcodebuild test -destination id=DEVICE-1"),
    );
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());

    await expect(client.isOwnedRunnerAlive(42, "DEVICE-1")).resolves.toBe(false);
  });

  test("signals the owned process group, then descendants, and escalates after the bounded wait", async () => {
    const host = new FakeHostCommandExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    host.setCommandResponse("ps -axo pid=,ppid=", result("42 1\n43 42\n"));
    host.setCommandResponse("kill -0 42", result());
    host.setCommandResponse("kill -0 43", result());
    const client = new IOSCtrlProxyProcessClient(host, timer, {
      releaseAttempts: 1,
      releaseGraceMs: 1,
    });

    await expect(client.terminateProcessTree(42)).rejects.toThrow(
      "CtrlProxy process tree rooted at PID 42 remained alive after SIGKILL",
    );

    expect(host.getExecutedCommands()).toEqual(
      expect.arrayContaining([
        "kill -TERM -- -42",
        "kill -TERM 43",
        "kill -TERM 42",
        "kill -KILL -- -42",
        "kill -KILL 43",
        "kill -KILL 42",
      ]),
    );
  });

  test("resolves process-tree termination once SIGKILL removes every target", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let killed = false;
    const host: HostCommandExecutor = {
      async executeCommand(file, args) {
        if (file === "ps") {
          return result("42 1\n43 42\n");
        }
        if (file === "kill" && args[0] === "-KILL") {
          killed = true;
          return result();
        }
        if (file === "kill" && args[0] === "-0" && killed) {
          throw new Error("not running");
        }
        return result();
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, timer, {
      releaseAttempts: 1,
      releaseGraceMs: 1,
    });

    await expect(client.terminateProcessTree(42)).resolves.toBeUndefined();
  });

  test("propagates deadline expiry while waiting for a process tree to exit", async () => {
    const timer = new FakeTimer();
    const host: HostCommandExecutor = {
      async executeCommand(file, args) {
        if (file === "ps") {
          return result("42 1\n");
        }
        if (file === "kill" && args[0] === "-0") {
          timer.advanceTime(100);
          throw new Error("kill -0 timed out");
        }
        return result();
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, timer, {
      releaseAttempts: 1,
      releaseGraceMs: 1,
    });

    await expect(client.terminateProcessTree(42, 100)).rejects.toThrow(
      "Startup CtrlProxy runner sweep deadline elapsed",
    );
  });

  test("treats permission failures as an unavailable PID rather than signaling it", async () => {
    const host = new FakeHostCommandExecutor();
    host.setCommandResponse("kill -0 77", result("", "Operation not permitted"));
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());

    await expect(client.isRunning(77)).resolves.toBe(false);
    expect(host.getExecutedCommands()).toEqual(["kill -0 77"]);
  });

  test("treats a kill -0 EPERM rejection as the process still running (#6137)", async () => {
    const host: HostCommandExecutor = {
      async executeCommand() {
        throw new Error(
          "Command failed: kill -0 77\nexit code: 1\nstderr: (last 4000 chars)\nOperation not permitted",
        );
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());

    await expect(client.isRunning(77)).resolves.toBe(true);
  });

  test("treats a kill -0 ESRCH rejection as the process not running", async () => {
    const host: HostCommandExecutor = {
      async executeCommand() {
        throw new Error(
          "Command failed: kill -0 77\nexit code: 1\nstderr: (last 4000 chars)\nNo such process",
        );
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());

    await expect(client.isRunning(77)).resolves.toBe(false);
  });

  test("treats a clean kill -0 exit as the process running", async () => {
    const host = new FakeHostCommandExecutor();
    host.setCommandResponse("kill -0 77", result());
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());

    await expect(client.isRunning(77)).resolves.toBe(true);
  });
});
