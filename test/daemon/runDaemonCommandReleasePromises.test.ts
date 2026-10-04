import { describe, expect, spyOn, test } from "bun:test";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonManager } from "../../src/daemon/manager";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import type { DaemonClientLike } from "../../src/daemon/client";
import { ActionableError } from "../../src/models/ActionableError";

function managerForCliRelease(callDaemonMethod: DaemonClientLike["callDaemonMethod"]) {
  const unexpected = () => {
    throw new Error("Unexpected daemon operation");
  };
  const state: DaemonStateLike = {
    isInitialized: () => false,
    getSessionManager: unexpected,
    getDevicePool: unexpected,
    getDeviceSessionRegistry: unexpected,
  };
  const client: DaemonClientLike = {
    connect: async () => {},
    close: async () => {},
    callDaemonMethod,
    callTool: unexpected,
    readResource: unexpected,
  };
  return class FakeManager extends SafeDaemonManager {
    override getDaemonState() {
      return state;
    }
    override createClient() {
      return client;
    }
  };
}

describe("CLI heartbeat ownership results", () => {
  test("superseded heartbeat uses the ActionableError non-zero exit path with re-claim guidance", async () => {
    const Manager = managerForCliRelease(async () => {
      throw Object.assign(new ActionableError("Displaced owner"), {
        code: "liveness_owner_superseded",
      });
    });
    const exited = new Error("fake exit");
    const log = spyOn(console, "log").mockImplementation(() => {});
    const report = spyOn(console, "error").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    try {
      await expect(
        runDaemonCommand("heartbeat", ["fake-session", "--liveness-owner-token", "A"], {}, Manager),
      ).rejects.toBe(exited);
      expect(exit).toHaveBeenCalledWith(1);
      expect(report).toHaveBeenCalledWith(
        expect.stringMatching(/^Error: .*no longer owns.*--claim-liveness-ownership.*stop/),
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      report.mockRestore();
      log.mockRestore();
    }
  });

  test.each([false, true])(
    "successful heartbeat still reports recorded (claim=%s)",
    async (claim) => {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const Manager = managerForCliRelease(async (method, params) => {
        calls.push({ method, params });
        return { sessionId: "fake-session" };
      });
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await runDaemonCommand(
          "heartbeat",
          [
            "fake-session",
            "--liveness-owner-token",
            "A",
            ...(claim ? ["--claim-liveness-ownership"] : []),
          ],
          {},
          Manager,
        );
        expect(log).toHaveBeenCalledWith("Session fake-session heartbeat recorded");
        expect(calls).toEqual([
          {
            method: "daemon/heartbeat",
            params: {
              sessionId: "fake-session",
              livenessPolicy: "cli",
              idleTimeoutMs: expect.any(Number),
              livenessOwnerToken: "A",
              ...(claim ? { claimLivenessOwnership: true } : {}),
            },
          },
        ]);
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe("CLI release-session daemon results", () => {
  test.each([
    {
      result: {
        message: "Session fake-session already released or never existed",
        alreadyReleased: true,
      },
      output: ["Session fake-session already released or never existed"],
    },
    {
      result: {
        message: "Session fake-session already released or never existed",
        alreadyReleased: true,
        device: "fake-device",
      },
      output: ["Session fake-session already released or never existed"],
    },
    {
      result: {
        message: "Session fake-session released",
        device: "fake-device",
        alreadyReleased: false,
      },
      output: ["Session fake-session released", "Device fake-device is now available"],
    },
    {
      result: { message: "Session fake-session released", alreadyReleased: false },
      output: ["Session fake-session released"],
    },
  ])("prints the daemon result faithfully: $result", async ({ result, output }) => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const Manager = managerForCliRelease(async (method, params) => {
      calls.push({ method, params });
      return result;
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Unexpected exit");
    });
    try {
      await runDaemonCommand("release-session", ["fake-session"], {}, Manager);
      expect(log.mock.calls).toEqual(output.map((line) => [line]));
      expect(exit).not.toHaveBeenCalled();
      expect(calls).toEqual([
        { method: "daemon/releaseSession", params: { sessionId: "fake-session" } },
      ]);
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  test.each([
    undefined,
    null,
    {},
    { message: "Released", alreadyReleased: "false" },
    { message: 5, alreadyReleased: true },
    { message: "Released", alreadyReleased: false, device: 5 },
    "Released",
  ])("rejects malformed release results: %j", async (result) => {
    const Manager = managerForCliRelease(async () => result);
    await expectCliReleaseFailure(Manager, "Invalid daemon release-session result");
  });

  test("a success:false client rejection exits through the release error boundary", async () => {
    // DaemonClient.handleResponse rejects success:false; callDaemonMethod exposes
    // only response.result on success, never the transport response envelope.
    const Manager = managerForCliRelease(async () => {
      throw new ActionableError("sessionId parameter required");
    });
    await expectCliReleaseFailure(Manager, "sessionId parameter required");
  });
});

async function expectCliReleaseFailure(Manager: new () => DaemonManager, message: string) {
  const exited = new Error("fake exit");
  const log = spyOn(console, "log").mockImplementation(() => {});
  const report = spyOn(console, "error").mockImplementation(() => {});
  const exit = spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  try {
    await expect(runDaemonCommand("release-session", ["fake-session"], {}, Manager)).rejects.toBe(
      exited,
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(report).toHaveBeenCalledWith(`Error: Failed to release session: ${message}`);
    expect(log).not.toHaveBeenCalled();
  } finally {
    exit.mockRestore();
    report.mockRestore();
    log.mockRestore();
  }
}

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
