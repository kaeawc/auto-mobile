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
  test("force termination retains a separate-group child after the root exits", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let rootAlive = true;
    let childAlive = true;
    const host: HostCommandExecutor = {
      async executeCommand(file, args) {
        if (file === "ps") {
          return result(rootAlive ? "42 1\n43 42\n" : "43 1\n");
        }
        if (args.includes("--")) {
          throw new Error("not a process group leader");
        }
        if (args[0] === "-KILL") {
          if (args[1] === "42") {
            rootAlive = false;
          }
          if (args[1] === "43") {
            childAlive = false;
          }
        }
        if (args[0] === "-0" && !(args[1] === "42" ? rootAlive : childAlive)) {
          throw new Error("No such process");
        }
        return result();
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, timer);

    await client.terminateProcessTree(42, 250, { skipGraceful: true });

    expect(rootAlive).toBe(false);
    expect(childAlive).toBe(false);
  });

  test("force termination reserves signaling time when discovery times out", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const commands: string[] = [];
    const host: HostCommandExecutor = {
      async executeCommand(file, args, options) {
        commands.push([file, ...args].join(" "));
        if (file === "ps") {
          await timer.sleep(options!.timeoutMs!);
          throw new Error("process discovery timed out");
        }
        if (args.includes("--")) {
          throw new Error("root is not a process group leader");
        }
        return result();
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, timer);

    await expect(client.terminateProcessTree(42, 250, { skipGraceful: true })).rejects.toThrow(
      "descendant discovery failed",
    );

    expect(commands).toEqual(["ps -axo pid=,ppid=", "kill -KILL -- -42", "kill -KILL 42"]);
    expect(timer.now()).toBe(50);
  });

  test("force termination skips TERM and bounds commands and exit waiting by its deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const commands: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const host: HostCommandExecutor = {
      async executeCommand(file, args, options) {
        commands.push([file, ...args].join(" "));
        timeouts.push(options?.timeoutMs);
        return result(file === "ps" ? "42 1\n43 42\n" : "");
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, timer);

    await expect(client.terminateProcessTree(42, 250, { skipGraceful: true })).rejects.toThrow(
      "deadline elapsed",
    );

    expect(commands).toEqual([
      "ps -axo pid=,ppid=",
      "kill -KILL -- -42",
      "kill -KILL 42",
      "kill -KILL 43",
      "kill -0 42",
    ]);
    expect(timeouts).toEqual([50, 250, 250, 250, 250]);
    expect(timer.now()).toBe(250);
  });

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
    expect(host.getExecutedCommands()).toContain("ps -p 42 -o ppid= -o args= -ww");
  });

  test("does not report a daemon-managed runner behind an orphaned shell as external, even when its own environment carries a device identity marker (#6372 predicate-divergence regression)", async () => {
    const host = new FakeHostCommandExecutor();
    host.setCommandResponse("pgrep -x xcodebuild", result("42\n"));
    host.setCommandResponse(
      "ps -p 42 -o ppid= -o args=",
      result(
        "500 xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=DEVICE-1 -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
      ),
    );
    // The runner's own environment carries AUTOMOBILE_DEVICE_ID=, which in
    // isolation looks like an externally (hot-reload) launched xcodebuild.
    host.setCommandResponse("ps eww -p 42 -o command=", result("AUTOMOBILE_DEVICE_ID=DEVICE-1"));
    // But its immediate parent is an orphaned shell wrapping the same
    // daemon-managed xcodebuild shape, so the runner is still daemon-owned.
    host.setCommandResponse(
      "ps -p 500 -o ppid= -o args=",
      result(
        "1 /bin/sh -c xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=DEVICE-1 -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
      ),
    );
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());

    const process = await client.findExternalXcodebuildCtrlProxyProcess("DEVICE-1");

    expect(process).toBeNull();
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

  test.each([100, 101])(
    "checks untruncated arguments and daemon parent PID (%s)",
    async (parentPid) => {
      const command = `${parentPid} xcodebuild test-without-building -xctestrun /tmp/${"long-path/".repeat(40)}CtrlProxy.xctestrun -destination id=DEVICE-1`;
      const host: HostCommandExecutor = {
        async executeCommand(file, args) {
          expect(file).toBe("ps");
          return result(args.includes("-ww") ? command : command.slice(0, 256));
        },
      };
      const client = new IOSCtrlProxyProcessClient(host, new FakeTimer(), { ownerPid: 100 });
      expect(await client.isOwnedRunnerAlive(42, "DEVICE-1")).toBe(parentPid === 100);
    },
  );

  test("recognizes the wrapped no-match ps exit without assuming ownership", async () => {
    const failure = Object.assign(new Error("no matching process"), {
      code: 1,
      stdout: "",
      stderr: "",
    });
    const host: HostCommandExecutor = {
      async executeCommand() {
        throw new Error("wrapped command failure", { cause: failure });
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());
    expect(await client.isOwnedRunnerAlive(42, "DEVICE-1")).toBe(false);
  });

  test("does not signal a PID recycled while descendants are enumerated", async () => {
    const commands: string[] = [];
    const host: HostCommandExecutor = {
      async executeCommand(file, args) {
        commands.push(`${file} ${args.join(" ")}`);
        if (args.includes("-axo")) {
          return result("42 100\n43 42");
        }
        return result("101 unrelated-process");
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer(), { ownerPid: 100 });
    await client.terminateProcessTree(42, 250, { expectedDeviceId: "DEVICE-1" });
    expect(commands.some((command) => command.startsWith("kill "))).toBe(false);
  });

  test("preserves a transient ownership inspection failure", async () => {
    const failure = new Error("ps temporarily unavailable");
    const host: HostCommandExecutor = {
      executeCommand: async () => {
        throw failure;
      },
    };
    const client = new IOSCtrlProxyProcessClient(host, new FakeTimer());
    await expect(client.isOwnedRunnerAlive(42, "DEVICE-1")).rejects.toBe(failure);
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
