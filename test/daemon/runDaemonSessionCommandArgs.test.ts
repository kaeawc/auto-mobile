import { describe, expect, spyOn, test } from "bun:test";
import {
  daemonCommandArgumentError,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

// `--daemon release-session <id> <other-id>` freed only the first session and exited 0; the second
// device stayed held for the idle window while the caller believed both were released. The
// lifecycle commands refuse stray words (#11252); the session commands take exactly one id
// (#11612).
describe("session commands take exactly one session id", () => {
  test.each([
    ["release-session", ["session-a", "session-b"]],
    ["session-info", ["session-a", "session-b"]],
    ["release-session", ["session-a", "--jsno"]],
    ["session-info", ["session-a", "--jsno"]],
    ["release-session", ["--jsno", "session-a"]],
    ["session-info", ["session-a", "--json=maybe"]],
    ["release-session", ["session-a", "--", "session-b"]],
    ["session-info", ["session-a", "--port", "3001"]],
  ])("%s %j is refused with a usage error", (command, args) => {
    expect(daemonCommandArgumentError(command, args)).toBeDefined();
  });

  test.each([
    ["release-session", ["session-a"]],
    ["session-info", ["session-a"]],
    ["release-session", ["session-a", "--json"]],
    ["release-session", ["--json", "session-a"]],
    ["session-info", ["--json=true", "session-a"]],
    ["session-info", ["session-a", "--json=false"]],
    ["release-session", ["--", "--json"]],
    ["release-session", ["--json", "--", "-odd-id"]],
  ])("%s %j keeps working", (command, args) => {
    expect(daemonCommandArgumentError(command, args)).toBeUndefined();
  });

  test("a missing id is still reported by the command itself, not as a stray word", () => {
    expect(daemonCommandArgumentError("release-session", [])).toBeUndefined();
    expect(daemonCommandArgumentError("session-info", ["--json"])).toBeUndefined();
  });
});

const unexpected = (): never => {
  throw new Error("Unexpected local daemon access");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

describe("a refused session command never reaches the daemon", () => {
  test.each([
    ["release-session", ["session-a", "session-b"]],
    ["session-info", ["session-a", "--jsno"]],
  ])("%s %j: usage on stderr, exit 1, no daemon call", async (command, args) => {
    const client = new FakeDaemonClient({});
    const output: Array<[string, unknown]> = [];
    const exited = new Error("fake exit");
    const log = spyOn(console, "log").mockImplementation((text) => output.push(["stdout", text]));
    const error = spyOn(console, "error").mockImplementation((text) =>
      output.push(["stderr", text]),
    );
    const exit = spyOn(process, "exit").mockImplementation((code) => {
      output.push(["exit", code]);
      throw exited;
    });
    try {
      await expect(
        runDaemonCommand(
          command,
          args,
          { clientFactory: () => client, stateProvider: () => remoteState },
          SafeDaemonManager,
        ),
      ).rejects.toBe(exited);
      expect(output[0]?.[0]).toBe("stderr");
      expect(output).toContainEqual(["exit", 1]);
      expect(client.callDaemonMethodCalls).toEqual([]);
    } finally {
      exit.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
