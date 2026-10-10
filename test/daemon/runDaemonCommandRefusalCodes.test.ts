import { describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";

const unexpected = (): never => {
  throw new Error("Unexpected daemon operation");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

/** A typed daemon refusal, shaped like `daemonResponseError` builds it (#11244). */
function typedRefusal(): Error {
  return Object.assign(new Error("Session is held by another owner"), {
    code: "session_owner_conflict",
    nextAction: "Wait for the owner to release it, or use another session.",
    retryable: true,
    retryAfterMs: 2000,
  });
}

async function runAgainstRefusingDaemon(command: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: unknown[] = [];
  const exited = new Error("fake exit");
  class Client extends FakeDaemonClient {
    override async connect() {}
    override async callDaemonMethod(): Promise<never> {
      throw typedRefusal();
    }
    override async readResource(): Promise<never> {
      throw typedRefusal();
    }
    override async close() {}
  }
  class Manager extends SafeDaemonManager {
    override getDaemonState() {
      return remoteState;
    }
    override createClient() {
      return new Client();
    }
  }
  const log = spyOn(console, "log").mockImplementation((text) => {
    stdout.push(String(text));
  });
  const error = spyOn(console, "error").mockImplementation((text) => {
    stderr.push(String(text));
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    exits.push(code);
    throw exited;
  });
  try {
    await expect(runDaemonCommand(command, args, {}, Manager)).rejects.toBe(exited);
  } finally {
    exit.mockRestore();
    error.mockRestore();
    log.mockRestore();
  }
  return { stdout, stderr, exits };
}

// #11252: these four re-wrapped a typed refusal as "Failed to ...: message", dropping its code.
describe("daemon queries keep the daemon's typed refusal", () => {
  test.each<[string, string[], string]>([
    ["release-session", ["s-1"], "Failed to release session"],
    ["session-info", ["s-1"], "Failed to get session info"],
    ["active-sessions", [], "Failed to query active sessions"],
    ["available-devices", [], "Failed to query available devices"],
  ])("%s prints the refusal code and next action", async (command, args, context) => {
    const { stderr, exits } = await runAgainstRefusingDaemon(command, args);
    expect(stderr).toEqual([
      `Error: ${context}: Session is held by another owner [session_owner_conflict] Next: Wait for the owner to release it, or use another session.`,
    ]);
    expect(exits).toEqual([1]);
  });

  test.each<[string, string[]]>([
    ["release-session", ["s-1", "--json"]],
    ["session-info", ["s-1", "--json"]],
    ["active-sessions", ["--json"]],
    ["available-devices", ["--json"]],
  ])("%s --json prints the refusal as one JSON object", async (command, args) => {
    const { stdout, stderr, exits } = await runAgainstRefusingDaemon(command, args);
    expect(stderr).toEqual([]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ok: false,
        error: "Session is held by another owner",
        code: "session_owner_conflict",
        nextAction: "Wait for the owner to release it, or use another session.",
        retryable: true,
        retryAfterMs: 2000,
      },
    ]);
    expect(exits).toEqual([1]);
  });

  test("release-session --json prints the released session", async () => {
    class Client extends FakeDaemonClient {
      override async connect() {}
      override async callDaemonMethod() {
        return { message: "released", alreadyReleased: false, device: "emulator-5554" };
      }
      override async close() {}
    }
    class Manager extends SafeDaemonManager {
      override getDaemonState() {
        return remoteState;
      }
      override createClient() {
        return new Client();
      }
    }
    const stdout: string[] = [];
    const log = spyOn(console, "log").mockImplementation((text) => {
      stdout.push(String(text));
    });
    try {
      await runDaemonCommand("release-session", ["s-1", "--json"], {}, Manager);
    } finally {
      log.mockRestore();
    }
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ok: true,
        sessionId: "s-1",
        alreadyReleased: false,
        message: "Session s-1 released",
        device: "emulator-5554",
      },
    ]);
  });
});
