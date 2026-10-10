import { describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../../src/daemon/daemonState";
import { daemonResponseError } from "../../../src/daemon/client";
import { SafeDaemonManager } from "../../fakes/SafeDaemonManager";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";

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
  const err = spyOn(console, "error").mockImplementation(() => {});
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
  return { stdout, exits };
}

describe("hunt: --json keeps the idle flag of an idle-window release", () => {
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
