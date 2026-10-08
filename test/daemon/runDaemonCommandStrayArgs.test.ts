import { describe, expect, spyOn, test } from "bun:test";
import {
  runDaemonCommand,
  strayDaemonCommandArgument,
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
    expect(strayDaemonCommandArgument("status", [])).toBeUndefined();
    expect(strayDaemonCommandArgument("status", ["--debug"])).toBeUndefined();
    expect(strayDaemonCommandArgument("status", ["--port", "3001"])).toBeUndefined();
    expect(strayDaemonCommandArgument("status", ["--debug", "--port", "3001", "x"])).toBe("x");
  });

  test("commands with positional arguments keep their own parsing", () => {
    expect(strayDaemonCommandArgument("session-info", ["abc"])).toBeUndefined();
    expect(strayDaemonCommandArgument("release-session", ["abc"])).toBeUndefined();
    expect(strayDaemonCommandArgument("heartbeat", ["abc"])).toBeUndefined();
  });
});
