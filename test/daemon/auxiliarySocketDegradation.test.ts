import { AuxiliarySocketHeldError } from "../../src/daemon/AuxiliarySocketHeldError";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonIdentity,
  type DaemonIdentityHost,
} from "../../src/daemon/daemonCore/DaemonIdentity";
import {
  AuxiliarySocketBindConflict,
  getUnavailableAuxiliarySockets,
  markAuxiliarySocketAvailable,
} from "../../src/daemon/auxiliarySocketAvailability";
import {
  SocketServerSingleton,
  type SocketServerLifecycle,
} from "../../src/daemon/socketServerSingleton";
import { SOCKET_PATH, DAEMON_LAUNCH_NONCE_ENV } from "../../src/daemon/constants";
import { logger } from "../../src/utils/logger";
import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { FakeTimer } from "../fakes/FakeTimer";
import { toDaemonStatus } from "../../src/daemon/clientResponseDecoding";
import type { AuxiliaryDaemonSocketName, PidFileData } from "../../src/daemon/types";

function identityHarness(
  persist: (record: PidFileData) => Promise<void> = async () => {},
  platform: NodeJS.Platform = process.platform,
  stat = () => ({ dev: 1, ino: 2 }),
  reportStartupFailure: (message: string) => void = () => {},
) {
  const host: DaemonIdentityHost = {
    pidFileWritten: () => true,
    setPidFileWritten: () => {},
    services: { options: () => ({}) },
    identity: {
      port: () => 3000,
      completeIdentityPublished: () => true,
      socketBindCommitted: () => true,
      incumbentOwnerGuard: () => {
        throw new Error("unused");
      },
      daemonSessionId: () => "child",
      generationStartedAt: () => 20,
      processStartedAt: () => 10,
      processGenerationToken: () => "linux:child",
    },
    cleanupDaemonFilesForShutdown: async () => {},
    writeEarlyOwnerRecord: async () => {},
    persistPidFileData: persist,
  };
  return new DaemonIdentity(host, { stat }, platform, () => ":memory:", reportStartupFailure);
}

class RefusedStream implements SocketServerLifecycle {
  isListening() {
    return false;
  }
  async start() {
    throw new AuxiliarySocketBindConflict("/fake/stream.sock", "TestStream");
  }
  async close() {
    throw new Error("pre-bind refusal must not need closing");
  }
}

describe("auxiliary stream degradation", () => {
  afterEach(() => {
    for (const warning of getUnavailableAuxiliarySockets()) {
      markAuxiliarySocketAvailable(warning.name);
    }
  });

  test("continues startup after a stream conflict, warns, and exposes unavailability over status", async () => {
    const identity = identityHarness();
    const singleton = new SocketServerSingleton<RefusedStream>();
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await identity.startAuxiliarySocket("observation-stream", () =>
        singleton.start(() => new RefusedStream()),
      );
      let continued = false;
      await identity.startAuxiliarySocket("performance-stream", async () => {
        continued = true;
      });
      expect(continued).toBe(true);
      expect(singleton.instance).toBeNull();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("/fake/stream.sock"),
        expect.any(AuxiliarySocketBindConflict),
      );
      expect(identity.getDaemonFileCleanupOptions().socketPaths).not.toContain("/fake/stream.sock");
      const server = createHarnessServer("/fake/control.sock", undefined, new FakeTimer());
      const raw = await server.dispatchLocalRequest({
        id: "status",
        type: "daemon_request",
        method: "ide/status",
        params: {},
      });
      expect(toDaemonStatus(raw, "/fake/control.sock").reportedSockets).not.toHaveProperty(
        "observation-stream",
      );
      expect(toDaemonStatus(raw, "/fake/control.sock").unavailableSockets).toEqual([
        {
          code: "AUXILIARY_SOCKET_UNAVAILABLE",
          name: "observation-stream",
          socketPath: "/fake/stream.sock",
        },
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  test.each<AuxiliaryDaemonSocketName>([
    "video-recording",
    "device-gesture-recording",
    "device-snapshot",
    "appearance",
  ])("keeps the control/configuration endpoint %s fatal", async (name) => {
    const error = new AuxiliarySocketBindConflict("/fake/config.sock", "Config");
    await expect(
      identityHarness().startAuxiliarySocket(name, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(getUnavailableAuxiliarySockets()).toEqual([]);
  });

  test("held optional stream exposes holder identity through status and clears its singleton", async () => {
    const error = new AuxiliarySocketHeldError("/fake/stream.sock", "Stream", {
      holderPid: 741,
      holderVersion: "0.0.old",
      holderVerified: true,
    });
    const singleton = new SocketServerSingleton<SocketServerLifecycle>();
    await identityHarness().startAuxiliarySocket("observation-stream", () =>
      singleton.start(() => ({
        isListening: () => false,
        start: async () => {
          throw error;
        },
        close: async () => {
          throw new Error("must not close incumbent");
        },
      })),
    );
    expect(singleton.instance).toBeNull();
    const server = createHarnessServer("/fake/control.sock", undefined, new FakeTimer());
    const status = await server.dispatchLocalRequest({
      id: "holder",
      type: "daemon_request",
      method: "ide/status",
      params: {},
    });
    expect(toDaemonStatus(status, "/fake/control.sock").unavailableSockets).toEqual([
      {
        code: "AUXILIARY_SOCKET_UNAVAILABLE",
        name: "observation-stream",
        socketPath: "/fake/stream.sock",
        ...error.holder,
      },
    ]);
  });

  test.each<AuxiliaryDaemonSocketName>([
    "video-recording",
    "device-gesture-recording",
    "device-snapshot",
    "appearance",
  ])("fatal held endpoint %s emits the holder line before refusing startup", async (name) => {
    const error = new AuxiliarySocketHeldError("/fake/config.sock", name, {
      holderPid: 741,
      holderVersion: "0.0.old",
      holderVerified: true,
    });
    const output: string[] = [];
    const identity = identityHarness(undefined, undefined, undefined, (line) => {
      output.push(line);
    });
    await expect(
      identity.startAuxiliarySocket(name, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(output).toEqual([error.message]);
    expect(output[0]).toContain("pid 741 (version 0.0.old; verified)");
    expect(getUnavailableAuxiliarySockets()).toEqual([]);
  });

  test("other stream startup failures remain fatal", async () => {
    const error = new Error("permission denied");
    await expect(
      identityHarness().startAuxiliarySocket("observation-stream", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  test("successful recovery clears the typed warning", async () => {
    const identity = identityHarness();
    await identity.startAuxiliarySocket("observation-stream", async () => {
      throw new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream");
    });
    await identity.startAuxiliarySocket("observation-stream", async () => {});
    expect(getUnavailableAuxiliarySockets()).toEqual([]);
  });

  test("records control inode alongside auxiliary inodes for cleanup", () => {
    const identity = identityHarness();
    identity.recordControlSocketIdentity();
    const options = identity.getDaemonFileCleanupOptions();
    expect(options.socketPaths).toContain(SOCKET_PATH);
    expect(options.socketFileIdentities.get(SOCKET_PATH)).toEqual({ dev: 1, ino: 2 });
  });
});

test("unknown future socket diagnostics cannot invalidate daemon identity", () => {
  const warning = {
    code: "AUXILIARY_SOCKET_UNAVAILABLE",
    name: "future-stream",
    socketPath: "/fake/future.sock",
  };
  expect(
    toDaemonStatus(
      { pid: 400, version: "test", unavailableSockets: [warning] },
      "/fake/control.sock",
    ),
  ).toMatchObject({
    pid: 400,
    version: "test",
    unavailableSockets: [warning],
  });
});

test("PID record omits degraded streams and publishes the launch nonce", async () => {
  const records: PidFileData[] = [];
  const identity = identityHarness(async (record) => {
    records.push(record);
  });
  const previousNonce = process.env[DAEMON_LAUNCH_NONCE_ENV];
  process.env[DAEMON_LAUNCH_NONCE_ENV] = "launch-uuid";
  try {
    await identity.startAuxiliarySocket("observation-stream", async () => {
      throw new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream");
    });
    await identity.writePidFile();
    expect(records[0]?.sockets).not.toHaveProperty("observation-stream");
    expect(records[0]?.sockets).toHaveProperty("control");
    expect(records[0]?.launchNonce).toBe("launch-uuid");
    const server = createHarnessServer("/fake/control.sock", undefined, new FakeTimer());
    const status = await server.dispatchLocalRequest({
      id: "nonce",
      type: "daemon_request",
      method: "ide/status",
      params: {},
    });
    expect(toDaemonStatus(status, "/fake/control.sock").launchNonce).toBe("launch-uuid");
  } finally {
    markAuxiliarySocketAvailable("observation-stream");
    if (previousNonce === undefined) {
      delete process.env[DAEMON_LAUNCH_NONCE_ENV];
    } else {
      process.env[DAEMON_LAUNCH_NONCE_ENV] = previousNonce;
    }
  }
});

test.each<NodeJS.Platform>(["win32", "linux"])(
  "socket stat failure uses the appropriate log level on %s",
  (platform) => {
    const identity = identityHarness(undefined, platform, () => {
      throw new Error("no inode");
    });
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      identity.recordControlSocketIdentity();
      expect(platform === "win32" ? debug : warn).toHaveBeenCalledWith(
        expect.stringContaining("Cannot record ownership"),
      );
      expect(platform === "win32" ? warn : debug).not.toHaveBeenCalled();
      expect(identity.getDaemonFileCleanupOptions().socketPaths).toEqual([]);
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  },
);
