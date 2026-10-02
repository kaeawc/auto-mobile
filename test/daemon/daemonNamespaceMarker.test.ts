import { describe, expect, test } from "bun:test";
import { parseDaemonSocketPath, parseDaemonProcessTable } from "../../src/daemon/processTable";
import { parseDaemonArgs } from "../../src/daemon/cli/daemonArgs";
import { parseArgs } from "../../src/cli/parseArgs";

const command = "auto-mobile --daemon-mode";
describe("daemon namespace argv marker", () => {
  test.each([
    ["--daemon-socket-path=/tmp/a.sock", "/tmp/a.sock"],
    ["--daemon-socket-path=/tmp/a.sock2", "/tmp/a.sock2"],
    ['--daemon-socket-path="/tmp/a socket.sock"', "/tmp/a socket.sock"],
    ["--daemon-socket-path '/tmp/a socket.sock'", "/tmp/a socket.sock"],
    ["--daemon-socket-path=%2Ftmp%2Fa%20socket.sock", "/tmp/a socket.sock"],
    ["--daemon-socket-path=%2Ftmp%2Fa%2520.sock", "/tmp/a%20.sock"],
    ["--daemon-socket-path=/tmp/a%20.sock", "/tmp/a%20.sock"],
    ["--daemon-socket-path=/tmp/a.sock --debug", "/tmp/a.sock"],
    ["--not-daemon-socket-path=/tmp/a.sock", undefined],
    ["--daemon-socket-path-extra=/tmp/a.sock", undefined],
    ['--daemon-socket-path="/tmp/a.sock"suffix', "/tmp/a.socksuffix"],
    ['--log-dir="x --daemon-socket-path=/tmp/a.sock y"', undefined],
    ['--daemon-socket-path="/tmp/a.sock', undefined],
    ["--daemon-socket-path=%zz", undefined],
    ["--daemon-socket-path=/a --daemon-socket-path=/b", undefined],
    ["--debug", undefined],
  ])("parses only complete unambiguous marker tokens: %s", (marker, expected) => {
    expect(parseDaemonSocketPath(`${command} ${marker}`)).toBe(expected);
  });

  test("prefix collision is a different namespace, and marked commands still pass ps filtering", () => {
    const marked = `${command} --daemon-socket-path=/tmp/a.sock2`;
    expect(parseDaemonSocketPath(marked)).not.toBe("/tmp/a.sock");
    expect(parseDaemonProcessTable(`21 1 0 ${marked}`, 1)).toMatchObject([
      { pid: 21, command: marked },
    ]);
  });

  test("both daemon-mode parsers tolerate the marker without changing launch options", () => {
    const args = [
      "--daemon-mode",
      "--daemon-socket-path=%2Ftmp%2Fa%20socket.sock",
      "--port",
      "3001",
    ];
    expect(parseDaemonArgs(args, {})).toEqual(parseDaemonArgs(["--port", "3001"], {}));
    expect(parseArgs(args, { warn() {} }, {})).toEqual(
      parseArgs(["--daemon-mode", "--port", "3001"], { warn() {} }, {}),
    );
  });
});
