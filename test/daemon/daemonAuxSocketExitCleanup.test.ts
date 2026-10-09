import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { cleanupDaemonFilesSync } from "../../src/daemon/daemonFiles";
import { SOCKET_PATH } from "../../src/daemon/constants";
import { getDaemonSocketPathsByName } from "../../src/daemon/socketPaths";
import type { AuxiliaryDaemonSocketName } from "../../src/daemon/types";
import { testOverrides } from "../../src/utils/testOverrides";
import { FakeTimer } from "../fakes/FakeTimer";

describe("daemon auxiliary socket exit cleanup", () => {
  const previousAuxDir = testOverrides.auxSocketDir;
  let directory: string;

  afterEach(() => {
    // Constructing a Daemon initializes the process-wide DaemonState; do not leak it to later files.
    DaemonState.getInstance().reset();
    testOverrides.auxSocketDir = previousAuxDir;
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
    directory = "";
  });

  function makeDaemon(): { daemon: Daemon; pidFilePath: string } {
    directory = mkdtempSync(join(tmpdir(), "daemon-aux-exit-"));
    testOverrides.auxSocketDir = directory;
    const daemon = new Daemon({}, undefined, new FakeTimer());
    daemon["socketBindCommitted"] = true;
    daemon["pidFileWritten"] = true;
    const pidFilePath = join(directory, "contender.pid");
    writeFileSync(pidFilePath, JSON.stringify({ pid: process.pid, socketPath: SOCKET_PATH }));
    return { daemon, pidFilePath };
  }

  function exitCleanup(daemon: Daemon, pidFilePath: string): void {
    const options = daemon["getDaemonFileCleanupOptions"]();
    // The control socket belongs to the test runner's ambient namespace.
    // Exercise exactly the aux subset from the exit handler's options.
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
    const otherOwnerPath = getDaemonSocketPathsByName()["test-recording"];
    writeFileSync(ownerPath, "owner socket");
    writeFileSync(otherOwnerPath, "owner socket");

    await expect(daemon["startAuxiliarySocket"]("video-recording", refusedBind)).rejects.toThrow(
      "another daemon is listening",
    );
    expect(daemon["getDaemonFileCleanupOptions"]().socketPaths).toEqual([SOCKET_PATH]);

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(ownerPath)).toBe(true);
    expect(existsSync(otherOwnerPath)).toBe(true);
  });

  test("owner exit unlinks its bound aux socket", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const ownedPath = getDaemonSocketPathsByName()["video-recording"];
    await daemon["startAuxiliarySocket"]("video-recording", fakeSuccessfulBind(ownedPath));
    expect(daemon["getDaemonFileCleanupOptions"]().socketPaths).toEqual([SOCKET_PATH, ownedPath]);

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(ownedPath)).toBe(false);
  });

  test("partial bind exit unlinks only the bound aux socket", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const paths = getDaemonSocketPathsByName();
    const ownedName: AuxiliaryDaemonSocketName = "video-recording";
    const refusedName: AuxiliaryDaemonSocketName = "test-recording";
    const ownedPath = paths[ownedName];
    const refusedPath = paths[refusedName];
    await daemon["startAuxiliarySocket"](ownedName, fakeSuccessfulBind(ownedPath));
    writeFileSync(refusedPath, "peer socket");
    await expect(daemon["startAuxiliarySocket"](refusedName, refusedBind)).rejects.toThrow();

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(ownedPath)).toBe(false);
    expect(existsSync(refusedPath)).toBe(true);
  });

  test("exit preserves a replacement at a previously bound path", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const socketPath = getDaemonSocketPathsByName()["video-recording"];
    await daemon["startAuxiliarySocket"]("video-recording", fakeSuccessfulBind(socketPath));
    renameSync(socketPath, join(directory, "old.sock"));
    writeFileSync(socketPath, "replacement socket");

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(socketPath)).toBe(true);
  });

  test("a successful rebind refreshes the owned socket identity", async () => {
    const { daemon, pidFilePath } = makeDaemon();
    const socketPath = getDaemonSocketPathsByName()["observation-stream"];
    await daemon["startAuxiliarySocket"]("observation-stream", fakeSuccessfulBind(socketPath));
    renameSync(socketPath, join(directory, "old.sock"));
    await daemon["startAuxiliarySocket"]("observation-stream", fakeSuccessfulBind(socketPath));

    exitCleanup(daemon, pidFilePath);

    expect(existsSync(socketPath)).toBe(false);
  });
});
