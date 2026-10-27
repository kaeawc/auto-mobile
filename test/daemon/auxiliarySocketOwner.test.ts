import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJsonFileAtomicSync } from "../../src/daemon/atomicJsonFile";
import { describe, expect, test } from "bun:test";
import {
  AuxiliarySocketOwner,
  type AuxiliarySocketOwnerFiles,
} from "../../src/daemon/auxiliarySocketOwner";
import { AuxiliarySocketHeldError } from "../../src/daemon/AuxiliarySocketHeldError";
import { ActionableError } from "../../src/models/ActionableError";
import { writeJsonFileAtomicSync } from "../../src/daemon/daemonFiles";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

const socketPath = "/isolated/appearance.sock";
const sidecarPath = `${socketPath}.owner.json`;
const inode = { dev: 1n, ino: 2n };
const recordedInode = { dev: 1, ino: 2, exactDev: "1", exactIno: "2" };
const identity = { pid: 741, version: "0.0.old", processGenerationToken: "linux:holder" };
const record = { ...identity, socketName: "Appearance", socketPath, ...recordedInode };

function harness() {
  const contents = new Map<string, string>();
  let currentInode = inode;
  let live = true;
  let token: string | undefined = identity.processGenerationToken;
  let beforeLink = () => {};
  const files: AuxiliarySocketOwnerFiles = {
    read: (path) => {
      const text = contents.get(path);
      if (text === undefined) {
        throw new Error("ENOENT");
      }
      return text;
    },
    write: (path, value) => {
      contents.set(path, JSON.stringify(value));
    },
    remove: (path) => {
      contents.delete(path);
    },
    rename: (from, to) => {
      const text = contents.get(from);
      if (text === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      contents.set(to, text);
      contents.delete(from);
    },
    link: (from, to) => {
      beforeLink();
      if (contents.has(to)) {
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      const text = contents.get(from);
      if (text === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      contents.set(to, text);
    },
    copyExclusive: (from, to) => {
      if (contents.has(to)) {
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      const text = contents.get(from);
      if (text === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      contents.set(to, text);
    },
    stat: () => currentInode,
    lstat: () => ({ isFile: () => true, size: 100 }),
  };
  const processes = {
    isProcessRunning: (pid: number) => live && pid === identity.pid,
    readProcessGenerationToken: () => token,
  };
  const owner = new AuxiliarySocketOwner(
    files,
    processes,
    () => identity,
    new CountingIdGenerator(),
  );
  return {
    owner,
    files,
    contents,
    setBeforeLink: (callback: () => void) => {
      beforeLink = callback;
    },
    setLive: (value: boolean) => {
      live = value;
    },
    setToken: (value: string | undefined) => {
      token = value;
    },
    setInode: (value: typeof inode) => {
      currentInode = value;
    },
  };
}

describe("auxiliary socket owner records", () => {
  // The liveness dependency deliberately has no signal capability.
  test("owner implementation has no process signal calls", () => {
    const source = readFileSync(
      new URL("../../src/daemon/auxiliarySocketOwner.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\.kill\s*\(|process\.kill/);
  });

  test.each([
    { isFile: () => false, size: 0 },
    { isFile: () => true, size: 4097 },
  ])("rejects non-regular or oversized metadata before reading", (metadata) => {
    const h = harness();
    let reads = 0;
    h.files.lstat = () => metadata;
    h.files.read = () => {
      reads++;
      throw new Error("must not read");
    };
    expect(h.owner.conflict(socketPath, "Appearance").holder).toEqual({ holderVerified: false });
    expect(reads).toBe(0);
  });
  test("publishes by socket path and removes its own record", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    expect(JSON.parse(h.contents.get(sidecarPath) ?? "null")).toEqual(record);
    h.owner.remove(socketPath);
    expect(h.contents.has(sidecarPath)).toBe(false);
  });

  test("leaves the successor's sidecar intact", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    const successor = JSON.stringify({ ...record, pid: 742, processGenerationToken: "linux:new" });
    h.contents.set(sidecarPath, successor);
    h.owner.remove(socketPath);
    expect(h.contents.get(sidecarPath)).toBe(successor);
  });

  for (const newerAtRestore of [false, true]) {
    test(`restores a successor sidecar published immediately after the ownership read (newerAtRestore=${newerAtRestore})`, () => {
      const h = harness();
      h.owner.publish(socketPath, "Appearance", inode);
      const successor = JSON.stringify({
        ...record,
        pid: 742,
        processGenerationToken: "linux:new",
      });
      const newest = JSON.stringify({
        ...record,
        pid: 743,
        processGenerationToken: "linux:newest",
      });
      // Model a newer atomic publication at the no-clobber restore boundary.
      h.setBeforeLink(() => {
        if (newerAtRestore) {
          h.contents.set(sidecarPath, newest);
        }
      });
      const read = h.files.read;
      h.files.read = (path) => {
        const text = read(path);
        if (path === sidecarPath) {
          h.contents.set(path, successor);
        }
        return text;
      };
      h.owner.remove(socketPath);
      expect(h.contents.get(sidecarPath)).toBe(newerAtRestore ? newest : successor);
      expect([...h.contents.keys()]).toEqual([sidecarPath]);
    });
  }

  test("restores a successor sidecar via exclusive copy when link throws EPERM", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    const successor = JSON.stringify({ ...record, pid: 742, processGenerationToken: "linux:new" });
    h.setBeforeLink(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    const read = h.files.read;
    h.files.read = (path) => {
      const text = read(path);
      if (path === sidecarPath) {
        h.contents.set(path, successor);
      }
      return text;
    };
    h.owner.remove(socketPath);
    expect(h.contents.get(sidecarPath)).toBe(successor);
    expect([...h.contents.keys()]).toEqual([sidecarPath]);
  });

  test("leaves metadata intact if the socket inode has changed", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    h.setInode({ dev: 1n, ino: 3n });
    h.owner.remove(socketPath);
    expect(h.contents.has(sidecarPath)).toBe(true);
    const error = h.owner.conflict(socketPath, "Appearance");
    expect(error.holder).toEqual({ holderVerified: false });
    expect(error.message).toContain("unknown holder");
    expect(error.message).not.toContain("741");
    expect(error.message).not.toContain(identity.version);
  });

  describe("file ids above 2^53 (NTFS)", () => {
    // These differ by one but round to the same number, so only the exact fields tell them apart.
    const large = { dev: 1n, ino: 12_947_848_930_067_504n };
    const neighbour = { dev: 1n, ino: large.ino + 1n };

    test("a replaced socket whose id rounds alike is not ours to clean up", () => {
      expect(Number(large.ino)).toBe(Number(neighbour.ino));
      const h = harness();
      h.owner.publish(socketPath, "Appearance", large);
      expect(JSON.parse(h.contents.get(sidecarPath) ?? "null")).toMatchObject({
        ino: Number(large.ino),
        exactIno: large.ino.toString(),
      });
      h.setInode(neighbour);
      h.owner.remove(socketPath);
      expect(h.contents.has(sidecarPath)).toBe(true);
      expect(h.owner.conflict(socketPath, "Appearance").holder).toEqual({ holderVerified: false });
      h.setInode(large);
      expect(h.owner.conflict(socketPath, "Appearance").holder.holderVerified).toBe(true);
    });

    test("a record without the exact fields compares its rounded numbers", () => {
      const h = harness();
      const legacy = {
        ...record,
        ino: Number(large.ino),
        exactDev: undefined,
        exactIno: undefined,
      };
      h.contents.set(sidecarPath, JSON.stringify(legacy));
      h.setInode(neighbour);
      expect(h.owner.conflict(socketPath, "Appearance").holder.holderVerified).toBe(true);
      h.setInode({ dev: 1n, ino: 3n });
      expect(h.owner.conflict(socketPath, "Appearance").holder).toEqual({ holderVerified: false });
    });
  });

  test("verifies a live OS generation", () => {
    const h = harness();
    h.contents.set(sidecarPath, JSON.stringify(record));
    const error = h.owner.conflict(socketPath, "Appearance");
    expect(error).toBeInstanceOf(AuxiliarySocketHeldError);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error.holder).toEqual({
      holderPid: 741,
      holderVersion: "0.0.old",
      holderVerified: true,
    });
    expect(error.message).toContain("pid 741 (version 0.0.old; verified)");
    expect(error.message).toContain(socketPath);
    expect(error.message).toContain("does not stop an incumbent daemon automatically");
    expect(error.message).toContain("kill 741");
  });

  test("uses the canonical Darwin UTC record field", () => {
    const h = harness();
    h.contents.set(
      sidecarPath,
      JSON.stringify({
        ...record,
        processGenerationToken: undefined,
        processGenerationTokenUtc: "darwin-utc:holder",
      }),
    );
    h.setToken("darwin-utc:holder");
    expect(h.owner.conflict(socketPath, "Appearance").holder.holderVerified).toBe(true);
  });

  test("a reused PID with a successor generation cannot remove its sidecar", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    const successor = JSON.stringify({ ...record, processGenerationToken: "linux:successor" });
    h.contents.set(sidecarPath, successor);
    h.owner.remove(socketPath);
    expect(h.contents.get(sidecarPath)).toBe(successor);
  });

  test("ignores a stale dead-pid record", () => {
    const h = harness();
    h.contents.set(sidecarPath, JSON.stringify(record));
    h.setLive(false);
    const error = h.owner.conflict(socketPath, "Appearance");
    expect(error.holder).toEqual({ holderVerified: false });
    expect(error.message).toContain("unknown holder");
    expect(error.message).not.toContain("741");
  });

  test.each(["linux:recycled", "darwin-utc:other", undefined])(
    "an alive PID with a mismatched/unavailable generation %s has an unknown holder",
    (token) => {
      const h = harness();
      h.contents.set(sidecarPath, JSON.stringify(record));
      h.setToken(token);
      const error = h.owner.conflict(socketPath, "Appearance");
      expect(error.holder).toEqual({ holderVerified: false });
      expect(error.message).toContain("unknown holder");
      expect(error.message).not.toContain("741");
      expect(error.message).not.toContain(identity.version);
      expect(error.message).not.toContain("kill 741");
    },
  );

  test.each([
    undefined,
    "{bad",
    "null",
    JSON.stringify({ ...record, pid: -1 }),
    ...["bad\nversion", "1\n", "1\r", "\x1b[31m", "v".repeat(65), ""].map((version) =>
      JSON.stringify({ ...record, version }),
    ),
    JSON.stringify({ ...record, socketPath: "/different/appearance.sock" }),
  ])("missing, corrupt, invalid or other-path sidecars are unknown: %s", (text) => {
    const h = harness();
    if (text !== undefined) {
      h.contents.set(sidecarPath, text);
    }
    expect(h.owner.conflict(socketPath, "Appearance").holder).toEqual({ holderVerified: false });
  });

  test("different socket directories do not share owner records", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    expect(h.owner.conflict("/another/appearance.sock", "Appearance").holder).toEqual({
      holderVerified: false,
    });
    expect(h.contents.has(sidecarPath)).toBe(true);
  });

  test("the real reader rejects symlinks before following their target", () => {
    if (process.platform === "win32") {
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "aux-owner-read-"));
    const path = join(directory, "stream.sock");
    try {
      symlinkSync("/dev/zero", `${path}.owner.json`);
      expect(new AuxiliarySocketOwner().conflict(path, "Stream").holder).toEqual({
        holderVerified: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "loose file"])(
    "exclusive writer refuses a planted temporary %s",
    (kind) => {
      if (process.platform === "win32") {
        return;
      }
      const directory = mkdtempSync(join(tmpdir(), "aux-owner-write-"));
      const path = join(directory, "owner.json");
      const temporary = `${path}.tmp`;
      const target = join(directory, "target");
      try {
        writeFileSync(target, "untouched");
        if (kind === "symlink") {
          symlinkSync(target, temporary);
        } else {
          writeFileSync(temporary, "planted", { mode: 0o666 });
        }
        expect(() => writePrivateJsonFileAtomicSync(path, record, () => temporary)).toThrow(
          "EEXIST",
        );
        expect(readFileSync(target, "utf8")).toBe("untouched");
        expect(lstatSync(temporary).isSymbolicLink()).toBe(kind === "symlink");
        expect(readFileSync(temporary, "utf8")).toBe(kind === "symlink" ? "untouched" : "planted");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("exclusive writer replaces a sidecar symlink with an owner-only regular file", () => {
    if (process.platform === "win32") {
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "aux-owner-write-"));
    const path = join(directory, "owner.json");
    const target = join(directory, "target");
    try {
      writeFileSync(target, "untouched", { mode: 0o666 });
      symlinkSync(target, path);
      writePrivateJsonFileAtomicSync(path, record);
      expect(readFileSync(target, "utf8")).toBe("untouched");
      expect(lstatSync(path).isFile()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the atomic writer publishes complete JSON before replacing the sidecar", () => {
    const contents = new Map<string, string>();
    const writes: string[] = [];
    writeJsonFileAtomicSync(sidecarPath, record, {
      createTemporaryPath: (path) => `${path}.tmp`,
      writeTemporaryFile: (path, text) => {
        expect(contents.has(sidecarPath)).toBe(false);
        contents.set(path, text);
        writes.push(path);
      },
      replaceFile: (from, to) => {
        expect(JSON.parse(contents.get(from) ?? "null")).toEqual(record);
        contents.set(to, contents.get(from) ?? "");
        contents.delete(from);
      },
      removeTemporaryFile: (path) => {
        contents.delete(path);
      },
    });
    expect(writes).toEqual([`${sidecarPath}.tmp`]);
    expect(JSON.parse(contents.get(sidecarPath) ?? "null")).toEqual(record);
    expect(contents.size).toBe(1);
  });
});
