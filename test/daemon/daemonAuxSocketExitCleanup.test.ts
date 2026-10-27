import { afterEach, describe, expect, test } from "bun:test";
import { useScratchRoot } from "../helpers/scratchRoot";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DaemonIdentity,
  type DaemonIdentityHost,
} from "../../src/daemon/daemonCore/DaemonIdentity";
import { cleanupDaemonFilesSync } from "../../src/daemon/daemonFiles";
import { SOCKET_PATH } from "../../src/daemon/wire/constants";
import { getDaemonSocketPathsByName } from "../../src/daemon/socketPaths";
import type { AuxiliaryDaemonSocketName } from "../../src/daemon/types";
import { testOverrides } from "../../src/utils/testOverrides";

describe("daemon auxiliary socket exit cleanup", () => {
  const previousAuxDir = testOverrides.auxSocketDir;
  let directory: string;
  const scratch = useScratchRoot("daemon-aux-exit-");

  afterEach(() => {
    testOverrides.auxSocketDir = previousAuxDir;
  });

  function makeDaemon(): { daemon: DaemonIdentity; pidFilePath: string } {
    directory = scratch.next();
    testOverrides.auxSocketDir = directory;
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
        daemonSessionId: () => "test",
        generationStartedAt: () => 1,
        processStartedAt: () => 1,
        processGenerationToken: () => undefined,
      },
      cleanupDaemonFilesForShutdown: async () => {},
      writeEarlyOwnerRecord: async () => {},
      persistPidFileData: async () => {},
    };
    const daemon = new DaemonIdentity(host);
    const pidFilePath = join(directory, "contender.pid");
    writeFileSync(pidFilePath, JSON.stringify({ pid: process.pid, socketPath: SOCKET_PATH }));
    return { daemon, pidFilePath };
  }

  function exitCleanup(daemon: DaemonIdentity, pidFilePath: string): void {
    const options = daemon.getDaemonFileCleanupOptions();
    // This fixture binds only auxiliary paths; the ambient control socket was
    // never recorded and cannot join destructive exit cleanup.
    cleanupDaemonFilesSync({
      ...options,
      pidFilePath,
      socketPaths: options.socketPaths.filter((socketPath) => socketPath !== SOCKET_PATH),
    });
  }

  function fakeSuccessfulBind(socketPath: string): () => Promise<void> {
    return async () => {
      writeFileSync(socketPath, "owned socket");
    };
  }

  function refusedBind(): Promise<never> {
    return Promise.reject(new Error("another daemon is listening"));
  }

  test("refused contender exit preserves the owner's aux socket", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const ownerPath = getDaemonSocketPathsByName()["video-recording"];
    const otherOwnerPath = getDaemonSocketPathsByName()["device-gesture-recording"];
    writeFileSync(ownerPath, "owner socket");
    writeFileSync(otherOwnerPath, "owner socket");

    await expect(daemon.startAuxiliarySocket("video-recording", refusedBind)).rejects.toThrow(
      "another daemon is listening",
    );
    expect(daemon.getDaemonFileCleanupOptions().socketPaths).toEqual([]);

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(ownerPath)).toBe(true);
    expect(existsSync(otherOwnerPath)).toBe(true);
  });

  test("owner exit unlinks its bound aux socket", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const ownedPath = getDaemonSocketPathsByName()["video-recording"];
    await daemon.startAuxiliarySocket("video-recording", fakeSuccessfulBind(ownedPath));
    expect(daemon.getDaemonFileCleanupOptions().socketPaths).toEqual([ownedPath]);

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(ownedPath)).toBe(false);
  });

  test("partial bind exit unlinks only the bound aux socket", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const paths = getDaemonSocketPathsByName();
    const ownedName: AuxiliaryDaemonSocketName = "video-recording";
    const refusedName: AuxiliaryDaemonSocketName = "device-gesture-recording";
    const ownedPath = paths[ownedName];
    const refusedPath = paths[refusedName];
    await daemon.startAuxiliarySocket(ownedName, fakeSuccessfulBind(ownedPath));
    writeFileSync(refusedPath, "peer socket");
    await expect(daemon.startAuxiliarySocket(refusedName, refusedBind)).rejects.toThrow();

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(ownedPath)).toBe(false);
    expect(existsSync(refusedPath)).toBe(true);
  });

  test("exit preserves a replacement at a previously bound path", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const socketPath = getDaemonSocketPathsByName()["video-recording"];
    await daemon.startAuxiliarySocket("video-recording", fakeSuccessfulBind(socketPath));
    renameSync(socketPath, join(directory, "old.sock"));
    writeFileSync(socketPath, "replacement socket");

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(socketPath)).toBe(true);
  });

  test("a successful rebind refreshes the owned socket identity", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const socketPath = getDaemonSocketPathsByName()["observation-stream"];
    await daemon.startAuxiliarySocket("observation-stream", fakeSuccessfulBind(socketPath));
    renameSync(socketPath, join(directory, "old.sock"));
    await daemon.startAuxiliarySocket("observation-stream", fakeSuccessfulBind(socketPath));

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(socketPath)).toBe(false);
  });
});
