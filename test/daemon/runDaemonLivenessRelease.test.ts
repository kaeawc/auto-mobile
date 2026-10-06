import { describe, expect, spyOn, test } from "bun:test";
import {
  parseDaemonReleaseLivenessCommandArgs,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

const unexpected = (): never => {
  throw new Error("Unexpected local daemon access");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

describe("release-liveness-ownership management command with fake transport", () => {
  test.each(
    [
      [],
      ["s"],
      ["s", "--liveness-owner-token"],
      ["s", "--liveness-owner-token", " "],
      ["s", "--liveness-owner-token", "--claim-liveness-ownership"],
      ["s", "--other", "t"],
      ["s", "--liveness-owner-token", "t", "extra"],
    ].map((args) => ({ args })),
  )("rejects malformed arguments $args", ({ args }) => {
    expect(() => parseDaemonReleaseLivenessCommandArgs(args)).toThrow(
      "Usage: release-liveness-ownership",
    );
  });
  test("sends exactly the current token and closes the fake connection", async () => {
    const client = new FakeDaemonClient({
      daemonMethodResults: new Map([
        ["daemon/releaseLivenessOwnership", { sessionId: "s", alreadyUnowned: false }],
      ]),
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDaemonCommand(
        "release-liveness-ownership",
        ["s", "--liveness-owner-token", "t"],
        {
          clientFactory: () => client,
          stateProvider: () => remoteState,
        },
        SafeDaemonManager,
      );
      expect(client.callDaemonMethodCalls).toEqual([
        {
          method: "daemon/releaseLivenessOwnership",
          params: { sessionId: "s", livenessOwnerToken: "t" },
        },
      ]);
      expect(client.isConnected()).toBe(false);
      expect(log).toHaveBeenCalledWith('{"sessionId":"s","alreadyUnowned":false}');
    } finally {
      log.mockRestore();
    }
  });
  test("a typed refusal exits nonzero, preserves the code, and closes the connection", async () => {
    const refused = Object.assign(new Error("not the owner"), {
      code: "liveness_owner_superseded",
    });
    const client = new FakeDaemonClient({
      onCallDaemonMethod: async () => {
        throw refused;
      },
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exited = new Error("fake exit");
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    try {
      await expect(
        runDaemonCommand(
          "release-liveness-ownership",
          ["s", "--liveness-owner-token", "t"],
          {
            clientFactory: () => client,
            stateProvider: () => remoteState,
          },
          SafeDaemonManager,
        ),
      ).rejects.toBe(exited);
      expect(error).toHaveBeenCalledWith(
        "Failed to release liveness ownership: not the owner [liveness_owner_superseded]",
      );
      expect(exit).toHaveBeenCalledWith(1);
      expect(client.isConnected()).toBe(false);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
