import { describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonManager } from "../../src/daemon/manager";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";

function managerForRelease(
  releaseSession: () => Promise<string | null>,
  releaseDevice: () => Promise<void>,
) {
  class FakeManager {
    getDaemonState(): DaemonStateLike {
      return {
        isInitialized: () => true,
        getSessionManager: () => ({
          getSession: () => ({ assignedDevice: "fake-device" }),
          releaseSession,
        }),
        getDevicePool: () => ({ releaseDevice }),
      } as unknown as DaemonStateLike;
    }
  }
  // This command only uses getDaemonState; no manager startup or daemon operations.
  return FakeManager as unknown as new () => DaemonManager;
}

describe("CLI release-session promise ownership", () => {
  test.each(["session", "device"] as const)(
    "handles %s release rejection through the command error boundary",
    async (failing) => {
      const error = new Error(`${failing} release rejected`);
      const exited = new Error("fake exit");
      const log = spyOn(console, "log").mockImplementation(() => {});
      const report = spyOn(console, "error").mockImplementation(() => {});
      const exit = spyOn(process, "exit").mockImplementation(() => {
        throw exited;
      });
      const calls: string[] = [];
      const Manager = managerForRelease(
        async () => {
          calls.push("session");
          if (failing === "session") {
            throw error;
          }
          return "fake-device";
        },
        async () => {
          calls.push("device");
          if (failing === "device") {
            throw error;
          }
        },
      );
      try {
        await expect(
          runDaemonCommand("release-session", ["fake-session"], {}, Manager),
        ).rejects.toBe(exited);
        expect(report).toHaveBeenCalledWith(`Unexpected error: ${failing} release rejected`);
        expect(exit).toHaveBeenCalledWith(1);
        expect(calls).toEqual(failing === "session" ? ["session"] : ["session", "device"]);
        expect(log).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        report.mockRestore();
        log.mockRestore();
      }
    },
  );

  test("waits for session removal then device release before reporting success", async () => {
    const timer = new FakeTimer();
    let finishSession!: (deviceId: string) => void;
    let finishDevice!: () => void;
    const session = new Promise<string>((resolve) => {
      finishSession = resolve;
    });
    const device = new Promise<void>((resolve) => {
      finishDevice = resolve;
    });
    const calls: string[] = [];
    const Manager = managerForRelease(
      () => {
        calls.push("session");
        return session;
      },
      () => {
        calls.push("device");
        return device;
      },
    );
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const command = runDaemonCommand("release-session", ["fake-session"], {}, Manager);
      expect(calls).toEqual(["session"]);
      expect(log).not.toHaveBeenCalled();
      finishSession("fake-device");
      await timer.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["session", "device"]);
      expect(log).not.toHaveBeenCalled();
      finishDevice();
      await command;
      expect(log).toHaveBeenCalledWith("Session fake-session released");
      expect(log).toHaveBeenCalledWith("Device fake-device is now available");
    } finally {
      log.mockRestore();
    }
  });
});
