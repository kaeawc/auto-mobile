import { describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import {
  buildSession,
  ScriptedDevicePool,
  ScriptedSessionManager,
  unexpected,
} from "./helpers/cliDaemonState";

describe("in-daemon CLI release caller ordering", () => {
  test.each(["success", "session", "pool"] as const)(
    "%s preserves arguments and boundary order",
    async (failure) => {
      const events: unknown[][] = [];
      const error = new Error(`${failure} failed`);
      const exited = new Error("command exited");
      const sessions = new ScriptedSessionManager({
        getSession: () => buildSession({ assignedDevice: "d1" }),
        releaseSession: async (...args) => {
          events.push(["session.releaseSession", ...args]);
          if (failure === "session") {
            throw error;
          }
          return "different-returned-device";
        },
      });
      const pool = new ScriptedDevicePool(sessions, {
        releaseDevice: async (...args) => {
          events.push(["pool.releaseDevice", ...args]);
          if (failure === "pool") {
            throw error;
          }
        },
      });
      const state: DaemonStateLike = {
        isInitialized: () => true,
        getSessionManager: () => sessions,
        getDevicePool: () => pool,
        getDeviceSessionRegistry: unexpected,
      };
      const log = spyOn(console, "log").mockImplementation((...args) => {
        events.push(["printReleased", ...args]);
      });
      const report = spyOn(console, "error").mockImplementation((...args) => {
        events.push(["error", ...args]);
      });
      const exit = spyOn(process, "exit").mockImplementation((code) => {
        events.push(["exit", code]);
        throw exited;
      });
      try {
        const command = runDaemonCommand(
          "release-session",
          ["s1"],
          { stateProvider: () => state },
          SafeDaemonManager,
        );
        if (failure === "success") {
          await command;
          expect(events).toEqual([
            ["session.releaseSession", "s1"],
            ["pool.releaseDevice", "d1", "s1"],
            ["printReleased", "Session s1 released"],
            ["printReleased", "Device d1 is now available"],
          ]);
        } else {
          // The command reports the original rejection and exits; it does not rethrow it directly.
          await expect(command).rejects.toBe(exited);
          expect(events).toEqual([
            ["session.releaseSession", "s1"],
            ...(failure === "pool" ? [["pool.releaseDevice", "d1", "s1"]] : []),
            ["error", `Unexpected error: ${failure} failed`],
            ["exit", 1],
          ]);
        }
      } finally {
        exit.mockRestore();
        report.mockRestore();
        log.mockRestore();
      }
    },
  );
});
