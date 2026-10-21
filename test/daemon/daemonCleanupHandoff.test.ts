import { describe, expect, test } from "bun:test";
import {
  cleanupDaemonFiles,
  cleanupDaemonFilesSync,
  type DaemonCleanupFileSystem,
} from "../../src/daemon/daemonFiles";
import type { PidFileData } from "../../src/daemon/types";

class CleanupFiles implements DaemonCleanupFileSystem {
  readonly paths = new Map([
    ["control.sock", { dev: 1n, ino: 1n }],
    ["aux.sock", { dev: 1n, ino: 2n }],
    ["owner.pid", { dev: 1n, ino: 3n }],
  ]);
  owner = 100;
  failControl = false;
  onAuxUnlink = () => {};
  exists = (path: string) => this.paths.has(path);
  stat = (path: string) => {
    const identity = this.paths.get(path);
    if (!identity) {
      throw new Error("absent");
    }
    return identity;
  };
  readPid = (): PidFileData => ({
    pid: this.owner,
    socketPath: "control.sock",
    port: 3000,
    startedAt: 1,
    version: "test",
  });
  persistedOwner: PidFileData | null = null;
  persistOwner = (owner: PidFileData | null) => {
    this.persistedOwner = owner;
    this.owner = 200;
  };
  unlinkSync = (path: string) => {
    if (path === "control.sock" && this.failControl) {
      throw new Error("EACCES");
    }
    this.paths.delete(path);
    if (path === "aux.sock") {
      this.onAuxUnlink();
    }
  };
  unlink = async (path: string) => this.unlinkSync(path);
  renameSync = (from: string, to: string) => {
    const entry = this.stat(from);
    this.paths.set(to, entry);
    this.paths.delete(from);
  };
  linkSync = (from: string, to: string) => {
    if (this.paths.has(to)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }
    this.paths.set(to, this.stat(from));
  };
  copyFileExclusiveSync = (from: string, to: string) => {
    if (this.paths.has(to)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }
    const entry = this.stat(from);
    this.paths.set(to, {
      dev: entry.dev,
      ino: [...this.paths.values()].reduce((max, { ino }) => (ino > max ? ino : max), 0n) + 1n,
    });
  };
}

const options = {
  pidFilePath: "owner.pid",
  controlSocketPath: "control.sock",
  socketPaths: ["control.sock", "aux.sock"],
  expectedPid: 100,
  socketFileIdentities: new Map([["control.sock", { dev: 1n, ino: 1n }]]),
};

describe("daemon cleanup handoff", () => {
  for (const synchronous of [false, true]) {
    const cleanup = (files: CleanupFiles) =>
      synchronous ? cleanupDaemonFilesSync(options, files) : cleanupDaemonFiles(options, files);

    test(`preserves a successor PID published during aux unlink (sync=${synchronous})`, async () => {
      const files = new CleanupFiles();
      files.onAuxUnlink = () => {
        files.owner = 200;
      };
      expect(await cleanup(files)).toBe(false);
      expect(files.exists("owner.pid")).toBe(true);
      expect(files.owner).toBe(200);
    });

    test(`persists only the validated owner and protects a subsequent handoff (sync=${synchronous})`, async () => {
      const files = new CleanupFiles();
      expect(await cleanup(files)).toBe(false);
      expect(files.persistedOwner?.pid).toBe(100);
      expect(files.exists("owner.pid")).toBe(true);
      expect(files.owner).toBe(200);
    });

    test(`preserves a replaced control socket (sync=${synchronous})`, async () => {
      const files = new CleanupFiles();
      files.paths.set("control.sock", { dev: 1n, ino: 9n });
      await cleanup(files);
      expect(files.stat("control.sock").ino).toBe(9n);
    });

    test(`keeps PID when our control socket cannot be removed (sync=${synchronous})`, async () => {
      const files = new CleanupFiles();
      files.failControl = true;
      expect(await cleanup(files)).toBe(false);
      expect(files.exists("owner.pid")).toBe(true);
      expect(files.exists("control.sock")).toBe(true);
    });
  }
});
