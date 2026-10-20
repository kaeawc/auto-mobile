import { describe, expect, test } from "bun:test";
import {
  AuxiliarySocketOwner,
  type AuxiliarySocketOwnerFiles,
} from "../../src/daemon/auxiliarySocketOwner";
import { AuxiliarySocketHeldError } from "../../src/daemon/AuxiliarySocketHeldError";
import { ActionableError } from "../../src/models/ActionableError";
import { writeJsonFileAtomicSync } from "../../src/daemon/daemonFiles";

const socketPath = "/isolated/appearance.sock";
const sidecarPath = `${socketPath}.owner.json`;
const inode = { dev: 1, ino: 2 };
const identity = { pid: 741, version: "0.0.old", processGenerationToken: "linux:holder" };
const record = { ...identity, socketName: "Appearance", socketPath, ...inode };

function harness() {
  const contents = new Map<string, string>();
  let currentInode = inode;
  let live = true;
  let token: string | undefined = identity.processGenerationToken;
  const signals: unknown[] = [];
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
    stat: () => currentInode,
  };
  const processes = {
    isProcessRunning: (pid: number) => live && pid === identity.pid,
    readProcessGenerationToken: () => token,
    signal: (...args: unknown[]) => {
      signals.push(args);
    },
  };
  const owner = new AuxiliarySocketOwner(files, processes, () => identity);
  return {
    owner,
    contents,
    signals,
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

  test("leaves metadata intact if the socket inode has changed", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    h.setInode({ dev: 1, ino: 3 });
    h.owner.remove(socketPath);
    expect(h.contents.has(sidecarPath)).toBe(true);
    expect(h.owner.conflict(socketPath, "Appearance").holder.holderVerified).toBe(false);
  });

  test("verifies a live OS generation and never invokes the signal seam", () => {
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
    expect(h.signals).toEqual([]);
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
    expect(h.signals).toEqual([]);
  });

  test.each(["linux:recycled", "darwin-utc:other", undefined])(
    "an alive PID with a mismatched/unavailable generation %s remains unverified",
    (token) => {
      const h = harness();
      h.contents.set(sidecarPath, JSON.stringify(record));
      h.setToken(token);
      const error = h.owner.conflict(socketPath, "Appearance");
      expect(error.holder).toEqual({
        holderPid: 741,
        holderVersion: "0.0.old",
        holderVerified: false,
      });
      expect(error.message).toContain("unverified: process generation could not be matched");
      expect(error.message).not.toContain("kill 741");
      expect(h.signals).toEqual([]);
    },
  );

  test.each([
    undefined,
    "{bad",
    "null",
    JSON.stringify({ ...record, pid: -1 }),
    JSON.stringify({ ...record, socketPath: "/different/appearance.sock" }),
  ])("missing, corrupt, invalid or other-path sidecars are unknown: %s", (text) => {
    const h = harness();
    if (text !== undefined) {
      h.contents.set(sidecarPath, text);
    }
    expect(h.owner.conflict(socketPath, "Appearance").holder).toEqual({ holderVerified: false });
    expect(h.signals).toEqual([]);
  });

  test("different socket directories do not share owner records", () => {
    const h = harness();
    h.owner.publish(socketPath, "Appearance", inode);
    expect(h.owner.conflict("/another/appearance.sock", "Appearance").holder).toEqual({
      holderVerified: false,
    });
    expect(h.contents.has(sidecarPath)).toBe(true);
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
