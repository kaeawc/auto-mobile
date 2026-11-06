import { describe, expect, test } from "bun:test";
import {
  type DisposableAppRecord,
  FileDisposableAppRegistry,
} from "../../../../src/features/prototype/disposableApp/DisposableAppRegistry";
import { InMemoryDisposableAppRegistryStore } from "../../../fakes/InMemoryDisposableAppRegistryStore";

function record(appId: string, overrides: Partial<DisposableAppRecord> = {}): DisposableAppRecord {
  return {
    appId,
    slug: "feedly",
    platform: "android",
    label: "Feedly",
    specSha256: "a".repeat(64),
    template: "base",
    signer: "host-key",
    installedAt: 0,
    expiresAt: null,
    ...overrides,
  };
}

describe("FileDisposableAppRegistry", () => {
  test("puts, replaces, lists per device and removes records", async () => {
    const store = new InMemoryDisposableAppRegistryStore();
    const registry = new FileDisposableAppRegistry(store);
    await Promise.all([
      registry.put("d1", record("app.b")),
      registry.put("d1", record("app.a")),
      registry.put("d2", record("app.c")),
    ]);
    await registry.put("d1", record("app.a", { label: "Renamed" }));
    expect((await registry.list("d1")).map((entry) => [entry.appId, entry.label])).toEqual([
      ["app.a", "Renamed"],
      ["app.b", "Feedly"],
    ]);
    await registry.remove("d2", "app.c");
    expect(await registry.list("d2")).toEqual([]);
    expect(JSON.parse(store.contents ?? "{}").devices).not.toHaveProperty("d2");
  });

  test.each([
    ["not JSON", "{oops"],
    ["an unknown version", JSON.stringify({ version: 9, devices: {} })],
    ["a non-object device", JSON.stringify({ version: 1, devices: { d1: [] } })],
  ])("a registry with %s is skipped, not fatal", async (_label, contents) => {
    const store = new InMemoryDisposableAppRegistryStore();
    store.contents = contents;
    const registry = new FileDisposableAppRegistry(store);
    expect(await registry.list("d1")).toEqual([]);
    await registry.put("d1", record("app.a"));
    expect((await registry.list("d1")).map((entry) => entry.appId)).toEqual(["app.a"]);
  });

  test("a malformed record is skipped while its siblings survive", async () => {
    const store = new InMemoryDisposableAppRegistryStore();
    store.contents = JSON.stringify({
      version: 1,
      devices: {
        d1: {
          "app.good": record("app.good"),
          "app.bad": { ...record("app.bad"), expiresAt: "soon" },
          "app.renamed": record("app.other"),
        },
      },
    });
    const registry = new FileDisposableAppRegistry(store);
    expect((await registry.list("d1")).map((entry) => entry.appId)).toEqual(["app.good"]);
  });
});
