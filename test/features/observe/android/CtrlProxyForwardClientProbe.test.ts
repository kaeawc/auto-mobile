import { describe, expect, test } from "bun:test";
import {
  HostForwardClientConnectionProbe,
  parseLsofForwardClientPids,
  parseNetstatForwardClientPids,
} from "../../../../src/features/observe/android/CtrlProxyForwardClientProbe";
import type { ExecResult } from "../../../../src/models";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../../src/utils/HostCommandExecutor";

// Captured on macOS (Darwin 25.6) with `lsof -nP -iTCP:49572 -sTCP:ESTABLISHED -Fpn`
// while one process held both ends of a loopback connection to port 49572:
// fd 5 is the client end, fd 6 the listener's accepted end.
const LSOF_BOTH_ENDS_ONE_PROCESS =
  "p92981\nf5\nn127.0.0.1:49573->127.0.0.1:49572\nf6\nn127.0.0.1:49572->127.0.0.1:49573\n";

// The capture above with the accepted end attributed to a separate adb server
// process, which is how a forwarded port looks: adb holds the accepted end.
const LSOF_ADB_AND_CLIENT =
  "p501\nf12\nn127.0.0.1:49572->127.0.0.1:49573\n" +
  "p92981\nf5\nn127.0.0.1:49573->127.0.0.1:49572\n";

// Windows `netstat -ano -p TCP` layout (header, listener, accepted end, client
// end, a TIME_WAIT row with PID 0). Not captured: no Windows host is available.
const NETSTAT_TCP = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:8765         0.0.0.0:0              LISTENING       501",
  "  TCP    127.0.0.1:8765         127.0.0.1:52144        ESTABLISHED     501",
  "  TCP    127.0.0.1:52144        127.0.0.1:8765         ESTABLISHED     7720",
  "  TCP    127.0.0.1:52100        127.0.0.1:8765         TIME_WAIT       0",
  "",
].join("\r\n");

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

/** Host executor whose answer for each command is scripted. */
class ScriptedHost implements HostCommandExecutor {
  readonly commands: string[] = [];
  constructor(private readonly answer: (command: string) => Promise<ExecResult>) {}
  async executeCommand(
    file: string,
    args: string[] = [],
    _options?: HostCommandOptions,
  ): Promise<ExecResult> {
    const command = [file, ...args].join(" ");
    this.commands.push(command);
    return this.answer(command);
  }
}

/** The shape the exec seam throws: a wrapper whose cause is execFile's error. */
function execFailure(code: number | string, stdout = "", stderr = ""): Error {
  const cause = Object.assign(new Error("Command failed"), { code, stdout, stderr });
  return new Error("Command failed: lsof", { cause });
}

describe("parseLsofForwardClientPids", () => {
  test("counts only the client end of a loopback connection", () => {
    expect(parseLsofForwardClientPids(LSOF_BOTH_ENDS_ONE_PROCESS, 49572)).toEqual([92981]);
    expect(parseLsofForwardClientPids(LSOF_ADB_AND_CLIENT, 49572)).toEqual([92981]);
  });

  test("ignores connections to other ports and empty output", () => {
    expect(parseLsofForwardClientPids(LSOF_ADB_AND_CLIENT, 8765)).toEqual([]);
    expect(parseLsofForwardClientPids("", 49572)).toEqual([]);
  });

  test("accepts an IPv6 loopback client", () => {
    expect(parseLsofForwardClientPids("p42\nf7\nn[::1]:50000->[::1]:8765\n", 8765)).toEqual([42]);
  });
});

describe("parseNetstatForwardClientPids", () => {
  test("counts the client end and skips the listener, accepted end and PID 0 rows", () => {
    expect(parseNetstatForwardClientPids(NETSTAT_TCP, 8765)).toEqual([7720]);
    expect(parseNetstatForwardClientPids(NETSTAT_TCP, 9000)).toEqual([]);
  });
});

describe("HostForwardClientConnectionProbe", () => {
  test("reads lsof on macOS and Linux", async () => {
    const host = new ScriptedHost(async () => execResult(LSOF_ADB_AND_CLIENT));
    const probe = new HostForwardClientConnectionProbe(host, "darwin");
    expect(await probe.findClientPids(49572)).toEqual([92981]);
    expect(host.commands).toEqual(["lsof -nP -iTCP:49572 -sTCP:ESTABLISHED -Fpn"]);
  });

  test("treats lsof's silent exit 1 as no clients", async () => {
    const probe = new HostForwardClientConnectionProbe(
      new ScriptedHost(async () => {
        throw execFailure(1);
      }),
      "linux",
    );
    expect(await probe.findClientPids(8765)).toEqual([]);
  });

  test("propagates a missing or failing lsof so callers stay conservative", async () => {
    const missing = new HostForwardClientConnectionProbe(
      new ScriptedHost(async () => {
        throw execFailure("ENOENT");
      }),
      "linux",
    );
    await expect(missing.findClientPids(8765)).rejects.toThrow("Command failed");

    const failing = new HostForwardClientConnectionProbe(
      new ScriptedHost(async () => {
        throw execFailure(1, "", "lsof: WARNING: can't stat()");
      }),
      "darwin",
    );
    await expect(failing.findClientPids(8765)).rejects.toThrow("Command failed");
  });

  test("reads IPv4 and IPv6 netstat tables on Windows", async () => {
    const host = new ScriptedHost(async (command) =>
      execResult(
        command.endsWith("TCPv6")
          ? "  TCP    [::1]:52150            [::1]:8765             ESTABLISHED     7721\r\n"
          : NETSTAT_TCP,
      ),
    );
    const probe = new HostForwardClientConnectionProbe(host, "win32");
    expect(await probe.findClientPids(8765)).toEqual([7720, 7721]);
    expect(host.commands).toEqual(["netstat -ano -p TCP", "netstat -ano -p TCPv6"]);
  });
});
