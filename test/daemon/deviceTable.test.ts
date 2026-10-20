import { describe, expect, test } from "bun:test";
import { InMemoryDeviceTable } from "../../src/daemon/deviceTable";
import type { PooledDevice } from "../../src/daemon/devicePool";

function device(id: string, overrides: Partial<PooledDevice> = {}): PooledDevice {
  return {
    id,
    name: id,
    platform: "android",
    sessionId: null,
    status: "idle",
    health: "ok",
    lastUsedAt: 0,
    assignmentCount: 0,
    incarnation: 0,
    errorCount: 0,
    ...overrides,
  };
}

describe("InMemoryDeviceTable", () => {
  test("set/get/has/delete/size track entries", () => {
    const table = new InMemoryDeviceTable();
    const a = device("a");
    table.set("a", a);
    expect(table.get("a")).toBe(a);
    expect(table.has("a")).toBe(true);
    expect(table.size).toBe(1);
    expect(table.delete("a")).toBe(true);
    expect(table.delete("a")).toBe(false);
    expect(table.get("a")).toBeUndefined();
    expect(table.size).toBe(0);
  });

  test("ids and all preserve insertion order and replacing keeps the slot", () => {
    const table = new InMemoryDeviceTable();
    table.set("b", device("b"));
    table.set("a", device("a"));
    const replacement = device("b", { name: "new" });
    table.set("b", replacement);
    expect(table.ids()).toEqual(["b", "a"]);
    expect(table.all()[0]).toBe(replacement);
  });

  test("heldBy finds the entry held by a session", () => {
    const table = new InMemoryDeviceTable();
    const held = device("a", { sessionId: "s1", status: "busy" });
    table.set("a", held);
    table.set("b", device("b"));
    expect(table.heldBy("s1")).toBe(held);
    expect(table.heldBy("missing")).toBeNull();
  });

  test("assigned returns busy held entries, errored returns error-health entries", () => {
    const table = new InMemoryDeviceTable();
    const busy = device("a", { sessionId: "s1", status: "busy" });
    const bad = device("b", { health: "error" });
    table.set("a", busy);
    table.set("b", bad);
    table.set("c", device("c"));
    expect(table.assigned()).toEqual([busy]);
    expect(table.errored()).toEqual([bad]);
  });

  test("byPlatform filters by platform", () => {
    const table = new InMemoryDeviceTable();
    const ios = device("i", { platform: "ios" });
    table.set("a", device("a"));
    table.set("i", ios);
    expect(table.byPlatform("ios")).toEqual([ios]);
    expect(table.byPlatform("android").map((d) => d.id)).toEqual(["a"]);
  });

  test("nextIncarnation is monotonic and independent of entries", () => {
    const table = new InMemoryDeviceTable();
    expect(table.nextIncarnation()).toBe(1);
    table.set("a", device("a"));
    table.delete("a");
    expect(table.nextIncarnation()).toBe(2);
  });

  test("backingMap reflects table mutations", () => {
    const table = new InMemoryDeviceTable();
    const a = device("a");
    table.set("a", a);
    expect(table.backingMap().get("a")).toBe(a);
  });
});
