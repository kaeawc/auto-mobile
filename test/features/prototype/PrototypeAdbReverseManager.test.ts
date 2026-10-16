import { describe, expect, test } from "bun:test";
import {
  createPrototypeReverseAdb,
  PrototypeAdbReverseManager,
  type PrototypeReverseAdb,
} from "../../../src/features/prototype/PrototypeAdbReverseManager";

class FakeReverseAdb implements PrototypeReverseAdb {
  readonly existing = new Set<number>();
  readonly calls: string[] = [];
  failAdd = new Set<number>();
  failList = false;
  failRemove = false;

  async listReversedPorts(): Promise<ReadonlySet<number>> {
    this.calls.push("list");
    if (this.failList) {
      throw new Error("list failed");
    }
    return new Set(this.existing);
  }

  async addReverse(port: number): Promise<void> {
    this.calls.push(`add ${port}`);
    if (this.failAdd.has(port)) {
      throw new Error("device offline");
    }
    this.existing.add(port);
  }

  async removeReverse(port: number): Promise<void> {
    this.calls.push(`remove ${port}`);
    if (this.failRemove) {
      throw new Error("gone");
    }
    this.existing.delete(port);
  }
}

const spec = (...urls: string[]) => ({
  root: urls.map((url) => ({ type: "request", via: "device", url })),
});

describe("PrototypeAdbReverseManager", () => {
  test("creates a reverse for each missing port and removes it on release", async () => {
    const adb = new FakeReverseAdb();
    const manager = new PrototypeAdbReverseManager();
    await manager.sync("dev", "p", spec("http://localhost:8080/", "http://[::1]:9000/"), adb);
    expect([...adb.existing].sort()).toEqual([8080, 9000]);
    expect(manager.ownedPorts("dev")).toEqual([8080, 9000]);
    await manager.release("dev", "p");
    expect(adb.existing.size).toBe(0);
    expect(manager.ownedPorts("dev")).toEqual([]);
  });

  test("a reverse that already existed is left alone and never removed", async () => {
    const adb = new FakeReverseAdb();
    adb.existing.add(8080);
    const manager = new PrototypeAdbReverseManager();
    await manager.sync("dev", "p", spec("http://localhost:8080/"), adb);
    expect(adb.calls).toEqual(["list"]);
    expect(manager.ownedPorts("dev")).toEqual([]);
    await manager.release("dev", "p");
    await manager.releaseAll("dev");
    expect(adb.existing.has(8080)).toBe(true);
    expect(adb.calls).toEqual(["list"]);
  });

  test("a port shared by two prototypes is removed with the last one", async () => {
    const adb = new FakeReverseAdb();
    const manager = new PrototypeAdbReverseManager();
    await manager.sync("dev", "a", spec("http://localhost:8080/"), adb);
    await manager.sync("dev", "b", spec("http://localhost:8080/"), adb);
    expect(adb.calls.filter((call) => call.startsWith("add"))).toEqual(["add 8080"]);
    await manager.release("dev", "a");
    expect(adb.existing.has(8080)).toBe(true);
    await manager.release("dev", "b");
    expect(adb.existing.has(8080)).toBe(false);
  });

  test("re-showing with a different port set drops the ports it no longer needs", async () => {
    const adb = new FakeReverseAdb();
    const manager = new PrototypeAdbReverseManager();
    await manager.sync("dev", "p", spec("http://localhost:1/", "http://localhost:2/"), adb);
    await manager.sync("dev", "p", spec("http://localhost:2/", "http://localhost:3/"), adb);
    expect([...adb.existing].sort()).toEqual([2, 3]);
  });

  test("releaseAll removes every owned reverse and forgets the device", async () => {
    const adb = new FakeReverseAdb();
    const other = new FakeReverseAdb();
    const manager = new PrototypeAdbReverseManager();
    await manager.sync("dev", "a", spec("http://localhost:1/"), adb);
    await manager.sync("dev", "b", spec("http://localhost:2/"), adb);
    await manager.sync("other", "a", spec("http://localhost:1/"), other);
    await manager.releaseAll("dev");
    expect(adb.existing.size).toBe(0);
    expect(other.existing.has(1)).toBe(true);
    expect(manager.report("dev")).toEqual({ unreversiblePorts: [], reverseFailures: [] });
  });

  test("a failed reverse is reported, never thrown, and not owned", async () => {
    const adb = new FakeReverseAdb();
    adb.failAdd.add(8080);
    const manager = new PrototypeAdbReverseManager();
    const report = await manager.sync("dev", "p", spec("http://localhost:8080/"), adb);
    expect(report.reverseFailures).toEqual([
      { prototypeId: "p", port: 8080, error: "device offline" },
    ]);
    expect(manager.report("dev").reverseFailures).toHaveLength(1);
    expect(manager.ownedPorts("dev")).toEqual([]);
    await manager.release("dev", "p");
    expect(adb.calls).not.toContain("remove 8080");
  });

  test("a failed list is reported for every port and adds nothing", async () => {
    const adb = new FakeReverseAdb();
    adb.failList = true;
    const manager = new PrototypeAdbReverseManager();
    const report = await manager.sync(
      "dev",
      "p",
      spec("http://localhost:1/", "http://localhost:2/"),
      adb,
    );
    expect(report.reverseFailures.map((failure) => failure.port)).toEqual([1, 2]);
    expect(adb.calls).toEqual(["list"]);
  });

  test("a failed removal does not throw and the claim is still dropped", async () => {
    const adb = new FakeReverseAdb();
    const manager = new PrototypeAdbReverseManager();
    await manager.sync("dev", "p", spec("http://localhost:1/"), adb);
    adb.failRemove = true;
    await manager.release("dev", "p");
    expect(manager.ownedPorts("dev")).toEqual([]);
    await manager.sync("dev", "q", spec("http://localhost:2/"), adb);
    await manager.releaseAll("dev");
    expect(manager.ownedPorts("dev")).toEqual([]);
  });

  test("unreversible URLs are reported per prototype until it is released", async () => {
    const adb = new FakeReverseAdb();
    const manager = new PrototypeAdbReverseManager();
    const url = "http://localhost:{state:port}/";
    await manager.sync("dev", "p", spec(url), adb);
    expect(manager.report("dev").unreversiblePorts).toEqual([
      { prototypeId: "p", url, reason: expect.stringContaining("binding") },
    ]);
    expect(adb.calls).toEqual([]);
    await manager.release("dev", "p");
    expect(manager.report("dev").unreversiblePorts).toEqual([]);
  });

  test("concurrent syncs of one port create a single reverse", async () => {
    const adb = new FakeReverseAdb();
    const manager = new PrototypeAdbReverseManager();
    await Promise.all([
      manager.sync("dev", "a", spec("http://localhost:8080/"), adb),
      manager.sync("dev", "b", spec("http://localhost:8080/"), adb),
    ]);
    expect(adb.calls.filter((call) => call.startsWith("add"))).toHaveLength(1);
  });
});

describe("createPrototypeReverseAdb", () => {
  test("issues the reverse commands and parses both list formats", async () => {
    const commands: string[] = [];
    const stdout = "host-19 tcp:8080 tcp:9090\n(reverse) tcp:3000 tcp:3000\n\n";
    const adapter = createPrototypeReverseAdb({
      executeCommand: async (command: string) => {
        commands.push(command);
        return { stdout, stderr: "" } as never;
      },
    });
    expect([...(await adapter.listReversedPorts())].sort()).toEqual([3000, 8080]);
    await adapter.addReverse(8080);
    await adapter.removeReverse(8080);
    expect(commands).toEqual([
      "reverse --list",
      "reverse tcp:8080 tcp:8080",
      "reverse --remove tcp:8080",
    ]);
  });
});
