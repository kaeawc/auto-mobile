import { describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { daemonResponseError } from "../../src/daemon/client";
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

async function runAgainst(error: Error, command: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: unknown[] = [];
  const exited = new Error("fake exit");
  class Client extends FakeDaemonClient {
    override async connect() {}
    override async callDaemonMethod(): Promise<never> {
      throw error;
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
  const err = spyOn(console, "error").mockImplementation((text) => {
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
    err.mockRestore();
    log.mockRestore();
  }
  return { stdout, stderr, exits };
}

describe("--json keeps the idle flag of an idle-window release", () => {
  // The daemon answers session-info for a session it released at the idle window with
  // { code: session_not_found, releaseReason: "cli-idle-timeout", idle: true } (#10832) so a client
  // can tell "reacquire" from a restart or loss. The wire client keeps `idle: true` on the error.
  const idleReleased = daemonResponseError({
    success: false,
    error: "Session not found: s-1",
    code: "session_not_found",
    releaseReason: "cli-idle-timeout",
    idle: true,
  } as never);

  test("the wire client error carries idle: true (premise)", () => {
    expect((idleReleased as unknown as { idle?: boolean }).idle).toBe(true);
  });

  test("session-info --json reports idle: true", async () => {
    const { stdout, exits } = await runAgainst(idleReleased, "session-info", ["s-1", "--json"]);
    expect(exits).toEqual([1]);
    expect(JSON.parse(stdout[0])).toMatchObject({
      ok: false,
      releaseReason: "cli-idle-timeout",
      idle: true,
    });
  });
});

describe("--json carries every typed field of the daemon's refusal", () => {
  const typed = {
    code: "device_busy",
    nextAction: "acquire_new_session",
    retryable: false,
    retryAfterMs: 2500,
    releaseReason: "cli-idle-timeout",
    idle: true,
    details: { limit: 3, booted: 2 },
  };

  test.each(Object.keys(typed))("%s survives into session-info --json unchanged", async (key) => {
    const error = Object.assign(new Error("Session not found: s-1"), typed);
    const { stdout } = await runAgainst(error, "session-info", ["s-1", "--json"]);
    expect(JSON.parse(stdout[0])[key]).toEqual(typed[key as keyof typeof typed]);
  });

  test("idle is omitted when the answer never had it", async () => {
    const error = Object.assign(new Error("gone"), { code: "session_not_found" });
    const { stdout } = await runAgainst(error, "session-info", ["s-1", "--json"]);
    expect("idle" in JSON.parse(stdout[0])).toBe(false);
  });

  test("the text form mentions idleness next to the release reason", async () => {
    const error = Object.assign(new Error("gone"), {
      releaseReason: "cli-idle-timeout",
      idle: true,
    });
    const { stderr } = await runAgainst(error, "session-info", ["s-1"]);
    expect(stderr.join("\n")).toContain("(released: cli-idle-timeout, idle)");
  });
});
