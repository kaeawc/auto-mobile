import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  HostForwardClientConnectionProbe,
  parseLsofForwardClientPids,
  parseNetstatForwardClientPids,
  parseSsForwardClientPids,
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

// Captured on a windows-latest GitHub runner with `netstat -ano -p TCP` and
// `netstat -ano -p TCPv6` (CRLF bytes kept; pinned -text in .gitattributes) while
// PID 8072 held both ends of loopback connections: 62741 (IPv4) and 62743 (IPv6).
// The IPv4 capture also carries TIME_WAIT rows with PID 0 and many LISTENING rows.
const NETSTAT_TCP = readFileSync(
  new URL("../../../fixtures/windows-netstat/netstat_ano_p_TCP.txt", import.meta.url),
  "utf8",
);
const NETSTAT_TCPV6 = readFileSync(
  new URL("../../../fixtures/windows-netstat/netstat_ano_p_TCPv6.txt", import.meta.url),
  "utf8",
);

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

// `ss -Htnp state established` rows (iproute2): with a single-state filter the
// State column is omitted. PID 4242 is the client; adb (PID 501) holds the
// accepted end whose peer is the client's ephemeral port.
const SS_ADB_AND_CLIENT =
  '0      0          127.0.0.1:8765      127.0.0.1:49573 users:(("adb",pid=501,fd=12))\n' +
  '0      0          127.0.0.1:49573     127.0.0.1:8765  users:(("node",pid=4242,fd=21),("node",pid=4243,fd=21))\n';

describe("parseSsForwardClientPids", () => {
  test("counts only the client end of a loopback connection", () => {
    expect(parseSsForwardClientPids(SS_ADB_AND_CLIENT, 8765)).toEqual([4242, 4243]);
    expect(parseSsForwardClientPids(SS_ADB_AND_CLIENT, 9000)).toEqual([]);
    expect(parseSsForwardClientPids("", 8765)).toEqual([]);
  });

  test("accepts a leading State column and IPv6 or v4-mapped loopback peers", () => {
    expect(
      parseSsForwardClientPids(
        'ESTAB 0 0 [::1]:50000 [::1]:8765 users:(("node",pid=42,fd=7))\n' +
          '0 0 [::ffff:127.0.0.1]:50001 [::ffff:127.0.0.1]:8765 users:(("node",pid=43,fd=8))\n',
        8765,
      ),
    ).toEqual([42, 43]);
  });

  test("ignores a non-loopback peer on the same port", () => {
    expect(
      parseSsForwardClientPids('0 0 10.0.0.2:50000 10.0.0.9:8765 users:(("x",pid=9,fd=3))', 8765),
    ).toEqual([]);
  });

  test("throws when a client connection's process is not visible", () => {
    expect(() => parseSsForwardClientPids("0 0 127.0.0.1:50000 127.0.0.1:8765\n", 8765)).toThrow(
      "not visible",
    );
  });
});

describe("parseNetstatForwardClientPids", () => {
  test("keeps the CRLF line endings of the real capture", () => {
    expect(NETSTAT_TCP).toContain("\r\n");
    expect(NETSTAT_TCPV6).toContain("\r\n");
  });

  test("counts the IPv4 client end and skips listeners, remote peers and PID 0 rows", () => {
    expect(parseNetstatForwardClientPids(NETSTAT_TCP, 62741)).toEqual([8072]);
    expect(parseNetstatForwardClientPids(NETSTAT_TCP, 62724)).toEqual([]);
    expect(parseNetstatForwardClientPids(NETSTAT_TCP, 443)).toEqual([]);
    expect(parseNetstatForwardClientPids(NETSTAT_TCP, 0)).toEqual([]);
  });

  test("counts the IPv6 loopback client end", () => {
    expect(parseNetstatForwardClientPids(NETSTAT_TCPV6, 62743)).toEqual([8072]);
    expect(parseNetstatForwardClientPids(NETSTAT_TCPV6, 22)).toEqual([]);
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

  test("propagates a failing lsof so callers stay conservative", async () => {
    const failing = new HostForwardClientConnectionProbe(
      new ScriptedHost(async () => {
        throw execFailure(1, "", "lsof: WARNING: can't stat()");
      }),
      "darwin",
    );
    await expect(failing.findClientPids(8765)).rejects.toThrow("Command failed");
  });

  test("falls back to ss on Linux when lsof is not installed (#18985)", async () => {
    const host = new ScriptedHost(async (command) => {
      if (command.startsWith("lsof")) {
        throw execFailure("ENOENT");
      }
      return execResult(SS_ADB_AND_CLIENT);
    });
    const probe = new HostForwardClientConnectionProbe(host, "linux");
    expect(await probe.findClientPids(8765)).toEqual([4242, 4243]);
    expect(host.commands).toEqual([
      "lsof -nP -iTCP:8765 -sTCP:ESTABLISHED -Fpn",
      "ss -Htnp state established dport = :8765",
    ]);
  });

  test("names both tools when neither lsof nor ss is installed", async () => {
    const probe = new HostForwardClientConnectionProbe(
      new ScriptedHost(async () => {
        throw execFailure("ENOENT");
      }),
      "linux",
    );
    await expect(probe.findClientPids(8765)).rejects.toThrow("neither lsof nor ss is installed");
  });

  test("does not fall back to ss on macOS", async () => {
    const host = new ScriptedHost(async () => {
      throw execFailure("ENOENT");
    });
    const probe = new HostForwardClientConnectionProbe(host, "darwin");
    await expect(probe.findClientPids(8765)).rejects.toThrow("Command failed");
    expect(host.commands).toEqual(["lsof -nP -iTCP:8765 -sTCP:ESTABLISHED -Fpn"]);
  });

  test("reads IPv4 and IPv6 netstat tables on Windows", async () => {
    const host = new ScriptedHost(async (command) =>
      execResult(command.endsWith("TCPv6") ? NETSTAT_TCPV6 : NETSTAT_TCP),
    );
    const probe = new HostForwardClientConnectionProbe(host, "win32");
    expect(await probe.findClientPids(62741)).toEqual([8072]);
    expect(await probe.findClientPids(62743)).toEqual([8072]);
    expect(host.commands).toEqual([
      "netstat -ano -p TCP",
      "netstat -ano -p TCPv6",
      "netstat -ano -p TCP",
      "netstat -ano -p TCPv6",
    ]);
  });
});
