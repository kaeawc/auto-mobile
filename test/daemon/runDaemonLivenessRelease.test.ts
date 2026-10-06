import { describe, expect, spyOn, test } from "bun:test";
import {
  parseDaemonReleaseLivenessCommandArgs,
  runDaemonCommand,
} from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

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
  test("initialized management dispatch releases only the owner token", async () => {
    const manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
    const session = await manager.createSession("s", "emulator-5554", "android");
    await manager.claimLivenessOwnership("s", "t");
    const before = { ...session };
    const state: DaemonStateLike = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: unexpected,
      getDeviceSessionRegistry: unexpected,
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runDaemonCommand(
        "release-liveness-ownership",
        ["s", "--liveness-owner-token", "t"],
        {
          stateProvider: () => state,
        },
        SafeDaemonManager,
      );
      expect(session).toEqual({
        ...before,
        livenessOwnerToken: undefined,
        activityGeneration: before.activityGeneration + 1,
      });
      expect(log).toHaveBeenCalledWith('{"sessionId":"s","alreadyUnowned":false}');
    } finally {
      manager.stopCleanupTimer();
      log.mockRestore();
    }
  });

  test("a former keeper sees an unowned refusal without claiming another owner exists", async () => {
    const client = new FakeDaemonClient({
      onCallDaemonMethod: async () => {
        throw Object.assign(new Error("unowned"), { code: "liveness_owner_unowned" });
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
          "heartbeat",
          ["s", "--liveness-owner-token", "t"],
          {
            clientFactory: () => client,
            stateProvider: () => remoteState,
          },
          SafeDaemonManager,
        ),
      ).rejects.toBe(exited);
      expect(error).toHaveBeenCalledWith(
        "Error: Session s's liveness is unowned. Explicitly claim with --claim-liveness-ownership before sending keeper ticks, or stop the keeper. [liveness_owner_unowned]",
      );
      expect(client.isConnected()).toBe(false);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
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
      code: "liveness_owner_not_owner",
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
        "Failed to release liveness ownership: not the owner [liveness_owner_not_owner]",
      );
      expect(exit).toHaveBeenCalledWith(1);
      expect(client.isConnected()).toBe(false);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
