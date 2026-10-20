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
import { SOCKET_PATH } from "../../src/daemon/constants";
import { logger } from "../../src/utils/logger";
import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { FakeTimer } from "../fakes/FakeTimer";
import { toDaemonStatus } from "../../src/daemon/clientResponseDecoding";
import type { AuxiliaryDaemonSocketName } from "../../src/daemon/types";

function identityHarness() {
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
    persistPidFileData: async () => {},
  };
  return new DaemonIdentity(host, { stat: () => ({ dev: 1, ino: 2 }) });
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
