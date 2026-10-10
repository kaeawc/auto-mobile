import { describe, expect, spyOn, test } from "bun:test";
import {
  daemonCommandArgumentError,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

describe("daemon command stray positional arguments", () => {
  test.each(["status", "health", "diagnose", "available-devices"])(
    "%s rejects a stray word with usage and exit 1",
    async (command) => {
      const output: unknown[] = [];
      const exited = new Error("fake exit");
      const log = spyOn(console, "log").mockImplementation((text) => {
        output.push(["stdout", text]);
      });
      const error = spyOn(console, "error").mockImplementation((text) => {
        output.push(["stderr", text]);
      });
      const exit = spyOn(process, "exit").mockImplementation((code) => {
        output.push(["exit", code]);
        throw exited;
      });
      try {
        await expect(runDaemonCommand(command, ["extra"], {}, SafeDaemonManager)).rejects.toBe(
          exited,
        );
        expect(output[0]).toEqual(["stderr", `Unexpected argument for daemon ${command}: extra`]);
        expect(output).toContainEqual(["stdout", "\nAvailable commands:"]);
        expect(output).toContainEqual(["exit", 1]);
      } finally {
        exit.mockRestore();
        error.mockRestore();
        log.mockRestore();
      }
    },
  );

  test("flags and flag values after the command are not stray", () => {
    expect(daemonCommandArgumentError("status", [])).toBeUndefined();
    expect(daemonCommandArgumentError("status", ["--debug"])).toBeUndefined();
    expect(daemonCommandArgumentError("status", ["--port", "3001"])).toBeUndefined();
    expect(daemonCommandArgumentError("status", ["--debug", "--port", "3001", "x"])).toBe(
      "Unexpected argument for daemon status: x",
    );
  });

  test("commands with positional arguments keep their own parsing", () => {
    expect(daemonCommandArgumentError("session-info", ["abc"])).toBeUndefined();
    expect(daemonCommandArgumentError("release-session", ["abc"])).toBeUndefined();
    expect(daemonCommandArgumentError("heartbeat", ["abc"])).toBeUndefined();
  });
});

// #11252: `--daemon stop <sessionId>` (meant as release-session) stopped the whole daemon, and
// `restart --stict-port` restarted it without the misspelled flag.
describe("daemon lifecycle commands refuse stray arguments and unknown options", () => {
  test.each([
    ["stop", ["session-123"], "Unexpected argument for daemon stop: session-123"],
    ["start", ["extra"], "Unexpected argument for daemon start: extra"],
    ["restart", ["--stict-port"], "Unknown option for daemon restart: --stict-port"],
    ["restart", ["now"], "Unexpected argument for daemon restart: now"],
    [
      "restart-admitted",
      ["--maintenance-token", "t", "extra"],
      "Unexpected argument for daemon restart-admitted: extra",
    ],
    [
      "restart-acceptance-session",
      ["--session-uuid", "s", "--port", "3000"],
      "Unknown option for daemon restart-acceptance-session: --port",
    ],
    ["stop", ["--debug", "x"], "Unexpected argument for daemon stop: x"],
    ["status", ["--no-such-flag"], "Unknown option for daemon status: --no-such-flag"],
  ])("%s %j is refused", (command, args, message) => {
    expect(daemonCommandArgumentError(command, args)).toBe(message);
  });

  test.each([
    ["stop", ["--port", "3920", "--strict-port"]],
    ["start", ["--network-mockable"]],
    ["start", ["--no-ui-perf-mode", "--skip-ctrl-proxy-download"]],
    ["restart", ["--debug", "--debug-perf"]],
    ["restart", ["--port=3001", "--video-fps", "30", "--event-all-markers", "@,#"]],
    ["start", ["--enable-tool", "observe", "--actions-no-observe"]],
    ["start", ["--daemon-socket-path=/tmp/x.sock"]],
    ["restart-admitted", ["--maintenance-token", "t", "--port", "3000"]],
    [
      "restart-acceptance-session",
      ["--session-uuid", "s", "--platform", "ios", "--expires-at", "1"],
    ],
  ])("%s %j keeps working", (command, args) => {
    expect(daemonCommandArgumentError(command, args)).toBeUndefined();
  });

  test("stop with a stray session id prints usage and exits before stopping", async () => {
    const output: unknown[] = [];
    const exited = new Error("fake exit");
    class Manager extends SafeDaemonManager {
      override async stop() {
        output.push("stopped");
      }
    }
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation((text) => {
      output.push(["stderr", text]);
    });
    const exit = spyOn(process, "exit").mockImplementation((code) => {
      output.push(["exit", code]);
      throw exited;
    });
    try {
      await expect(runDaemonCommand("stop", ["session-123"], {}, Manager)).rejects.toBe(exited);
      expect(output[0]).toEqual(["stderr", "Unexpected argument for daemon stop: session-123"]);
      expect(output).not.toContain("stopped");
    } finally {
      exit.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
