import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "../../src/cli/parseArgs";
import { printUnknownDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";

const logger = { warn: () => {} };
const invocationError = (args: string[]) => parseArgs(args, logger, {}).invalidInvocation;

describe("invocationError (#10132)", () => {
  describe("command lines that must keep starting the stdio MCP server", () => {
    // Each argv is what an MCP client config or the Dockerfile passes after the
    // package/script name: scripts/install.sh writes `bunx @kaeawc/auto-mobile@latest`
    // with an optional `--debug --debug-perf`; the Docker image runs the bare entry;
    // docs/using/dynamic-tools.md documents --enable-tool / --disable-tool; the
    // daemon launcher spawns `--daemon-mode`.
    const clientArgv: Array<[string, string[]]> = [
      ["bare invocation (bunx @kaeawc/auto-mobile@latest, docker run)", []],
      ["install.sh debug launch", ["--debug", "--debug-perf"]],
      [
        "documented dynamic tool flags",
        ["--enable-tool", "clipboard", "--enable-tool", "sqlQuery"],
      ],
      ["documented disable flag", ["--disable-tool", "observe"]],
      ["daemon launcher spawn", ["--daemon-mode"]],
      ["value flags with their values", ["--port", "8080", "--host", "127.0.0.1"]],
      ["inline flag values", ["--port=8080", "--host=127.0.0.1"]],
      ["no-proxy direct launch", ["--no-proxy"]],
      ["hand-parsed value flag", ["--tool-outputs-dir", "/tmp/out", "--event-all-markers", "@,/"]],
      ["unknown value flag keeps its value", ["--some-future-flag", "value"]],
      ["a quoted empty shell variable (#10135)", [""]],
      ["empty elements among real flags (#10135)", ["--debug", "", "--debug-perf"]],
      ["socket-path marker", ["--daemon-mode", "--daemon-socket-path", "/tmp/am/daemon.sock"]],
    ];

    test.each(clientArgv)("%s", (_label, argv) => {
      expect(invocationError(argv)).toBeUndefined();
      // parseArgs must still accept it as a stdio launch (not CLI, no daemon command).
      const parsed = parseArgs(argv, logger, {});
      expect(parsed.cliMode).toBe(false);
      expect(parsed.daemonCommand).toBeUndefined();
    });
  });

  describe("command lines that already dispatch", () => {
    const dispatched: Array<[string, string[]]> = [
      ["cli tool", ["--cli", "observe"]],
      ["cli with no tool (prints help)", ["--cli"]],
      ["cli after launch flags", ["--debug", "--cli", "doctor", "--json"]],
      ["cli value that is a bare word", ["--port", "9000", "--cli", "listApps"]],
      ["daemon subcommand", ["--daemon", "status"]],
      ["daemon subcommand with argument", ["--daemon", "heartbeat", "session-1"]],
      ["unknown daemon subcommand (printer reports it)", ["--daemon", "bogus"]],
      ["boot-device", ["--boot-device", "--platform", "ios", "--create-if-missing"]],
      [
        "cli tool argument that looks like a daemon flag (#10135)",
        ["--cli", "sendKeys", "--text", "--daemon=x"],
      ],
      ["cli tool argument that looks like a cli flag (#10135)", ["--cli", "observe", "--cli=x"]],
      [
        "daemon argument that looks like a mode flag (#10135)",
        ["--daemon", "heartbeat", "--cli=x"],
      ],
    ];

    test.each(dispatched)("%s", (_label, argv) => {
      expect(invocationError(argv)).toBeUndefined();
    });
  });

  test("a bare --daemon uses main's command printer and exits with usage", () => {
    const parsed = parseArgs(["--daemon"], logger, {});
    expect(parsed.daemonRequested).toBe(true);
    expect(parsed.daemonCommand).toBeUndefined();
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((message) => output.push(String(message)));
    const error = spyOn(console, "error").mockImplementation((message) =>
      output.push(String(message)),
    );
    const exited = new Error("fake exit");
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    try {
      expect(() => printUnknownDaemonCommand(parsed.daemonCommand)).toThrow(exited);
      expect(output.join("\n")).toContain("Missing daemon command.");
      expect(output.join("\n")).toContain("Available commands:");
      expect(output.join("\n")).toContain("status");
      expect(output.join("\n")).toContain("session-info <id>");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  test("a trailing --daemon after launch flags also reaches the usage printer", () => {
    const parsed = parseArgs(["--debug", "--daemon"], logger, {});
    expect(parsed.daemonRequested).toBe(true);
    expect(parsed.daemonCommand).toBeUndefined();
  });

  test("--cli=<tool> and --daemon=<command> are rejected with the space-separated form", () => {
    expect(invocationError(["--cli=observe"])).toContain("Use --cli <tool>");
    expect(invocationError(["--daemon=status"])).toContain("Use --daemon status");
    expect(invocationError(["--boot-device=ios"])).toContain("--boot-device --platform");
  });

  test("a malformed mode flag before a real mode flag is still rejected (#10135)", () => {
    expect(invocationError(["--debug", "--cli=observe"])).toContain("Use --cli <tool>");
    expect(invocationError(["--daemon=status", "--cli", "observe"])).toContain(
      "Use --daemon status",
    );
  });

  test("an empty element does not hide a real usage error (#10135)", () => {
    expect(invocationError(["", "doctor"])).toContain("Unexpected argument: doctor");
    const parsed = parseArgs(["--daemon", ""], logger, {});
    expect(parsed.daemonRequested).toBe(true);
    expect(parsed.daemonCommand).toBeUndefined();
  });

  test("a stray word is rejected with main's usage hint", () => {
    expect(invocationError(["doctor"])).toContain("did you mean --cli doctor");
    expect(invocationError(["status"])).toContain("did you mean --cli status");
    expect(invocationError(["--debug", "doctor"])).toContain("Unexpected argument: doctor");
    expect(invocationError(["--port", "8080", "doctor"])).toContain("--cli doctor");
  });

  test("empty tool values remain in the command argv", () => {
    const parsed = parseArgs(["--cli", "inputText", "--text", ""], logger, {});
    expect(parsed.invalidInvocation).toBeUndefined();
    expect(parsed.cliArgs).toEqual(["inputText", "--text", ""]);
  });

  test("unknown launcher flags consume one value but do not hide a later stray word", () => {
    expect(invocationError(["--some-future-flag", "value", "doctor"])).toContain("--cli doctor");
  });

  test("words after a mode flag belong to that mode, not to the stray-word check", () => {
    expect(invocationError(["--cli", "doctor", "extra", "words"])).toBeUndefined();
    expect(invocationError(["--daemon", "session-info", "abc"])).toBeUndefined();
  });
});
