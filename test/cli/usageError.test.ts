import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/parseArgs";
import { findUsageError } from "../../src/cli/usageError";

const logger = { warn: () => {} };

describe("findUsageError (#10132)", () => {
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
      expect(findUsageError(argv)).toBeUndefined();
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
      expect(findUsageError(argv)).toBeUndefined();
    });
  });

  test("a bare --daemon names the available commands and an example", () => {
    const message = findUsageError(["--daemon"]);
    expect(message).toContain("--daemon requires a command");
    expect(message).toContain("status");
    expect(message).toContain("session-info <id>");
    expect(message).toContain("auto-mobile --daemon status");
  });

  test("a trailing --daemon after launch flags is also rejected", () => {
    expect(findUsageError(["--debug", "--daemon"])).toContain("--daemon requires a command");
  });

  test("--cli=<tool> and --daemon=<command> are rejected with the space-separated form", () => {
    expect(findUsageError(["--cli=observe"])).toContain("Did you mean: auto-mobile --cli observe");
    expect(findUsageError(["--daemon=status"])).toContain(
      "Did you mean: auto-mobile --daemon status",
    );
    expect(findUsageError(["--boot-device=ios"])).toContain("--boot-device --platform");
  });

  test("a malformed mode flag before a real mode flag is still rejected (#10135)", () => {
    expect(findUsageError(["--debug", "--cli=observe"])).toContain(
      "Did you mean: auto-mobile --cli observe",
    );
    expect(findUsageError(["--daemon=status", "--cli", "observe"])).toContain(
      "Did you mean: auto-mobile --daemon status",
    );
  });

  test("an empty element does not hide a real usage error (#10135)", () => {
    expect(findUsageError(["", "doctor"])).toContain("Unexpected argument 'doctor'");
    expect(findUsageError(["--daemon", ""])).toContain("--daemon requires a command");
  });

  test("a stray word is rejected with the nearest valid form", () => {
    expect(findUsageError(["doctor"])).toContain("Did you mean: auto-mobile --cli doctor");
    expect(findUsageError(["status"])).toContain("Did you mean: auto-mobile --daemon status");
    expect(findUsageError(["--debug", "doctor"])).toContain("Unexpected argument 'doctor'");
    expect(findUsageError(["--port", "8080", "doctor"])).toContain("--cli doctor");
  });

  test("words after a mode flag belong to that mode, not to the stray-word check", () => {
    expect(findUsageError(["--cli", "doctor", "extra", "words"])).toBeUndefined();
    expect(findUsageError(["--daemon", "session-info", "abc"])).toBeUndefined();
  });
});
