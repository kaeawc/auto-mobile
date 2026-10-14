import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { FilePrototypeAssetCache } from "../../../src/features/prototype/prototypeAssetCache";
import { FakeMirrorFileSystem } from "../../fakes/FakeMirrorFileSystem";
import { logger } from "../../../src/utils/logger";

import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";

const upload = (id = "photo", bytes = [1, 2]) => ({
  id,
  mimeType: "image/png" as const,
  bytes: new Uint8Array(bytes),
});
function harness(maxBytes = 64) {
  const files = new FakeMirrorFileSystem();
  let clock = 0;
  const cache = new FilePrototypeAssetCache(
    files,
    () => "/cache",
    () => ++clock,
    maxBytes,
  );
  return {
    files,
    cache,
    fresh: () =>
      new FilePrototypeAssetCache(
        files,
        () => "/cache",
        () => ++clock,
        maxBytes,
      ),
  };
}
const warnings: ReturnType<typeof spyOn<typeof logger, "warn">>[] = [];
function silence() {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  warnings.push(warn);
  return warn;
}
afterEach(() => {
  for (const warn of warnings.splice(0)) {
    warn.mockRestore();
  }
});
describe("persistent prototype asset cache", () => {
  test("round trip and restart preserve arbitrary ids and isolate devices", async () => {
    const { cache, fresh } = harness();
    const asset = upload("../任意/id");
    await cache.put("device", asset);
    expect(await cache.get("device", asset.id)).toEqual(asset);
    expect(await fresh().get("device", asset.id)).toEqual(asset);
    expect(await cache.get("other", asset.id)).toBeUndefined();
    expect(await cache.ids("device")).toEqual(new Set([asset.id]));
  });
  test("deduplicates blobs and remove only deletes orphan bytes", async () => {
    const { cache, files } = harness();
    await cache.put("d", upload("a"));
    await cache.put("d", upload("b"));
    const blobs = () => [...files.files.keys()].filter((file) => file.includes("/blobs/"));
    expect(blobs()).toHaveLength(1);
    await cache.remove("d", "a");
    expect(await cache.ids("d")).toEqual(new Set(["b"]));
    expect(blobs()).toHaveLength(1);
    await cache.remove("d", "b");
    await cache.remove("d", "b");
    expect(blobs()).toHaveLength(0);
  });
  test("replacement drops old orphan and returns new bytes", async () => {
    const { cache, files } = harness();
    await cache.put("d", upload());
    await cache.put("d", upload("photo", [3]));
    expect(await cache.get("d", "photo")).toEqual(upload("photo", [3]));
    expect([...files.files.keys()].filter((file) => file.includes("/blobs/"))).toHaveLength(1);
  });
  test("LRU persists get recency and protects the newly put entry", async () => {
    const { cache, fresh } = harness(4);
    await cache.put("d", upload("a", [1, 1]));
    await cache.put("d", upload("b", [2, 2]));
    await cache.get("d", "a");
    await fresh().put("d", upload("c", [3, 3]));
    expect(await cache.ids("d")).toEqual(new Set(["a", "c"]));
  });
  test("deduplicated size and tied recency evict in index order", async () => {
    const files = new FakeMirrorFileSystem();
    const cache = new FilePrototypeAssetCache(
      files,
      () => "/cache",
      () => 1,
      2,
    );
    await cache.put("d", upload("a"));
    await cache.put("d", upload("b"));
    expect(await cache.ids("d")).toEqual(new Set(["a", "b"]));
    await cache.put("d", upload("c", [3, 4]));
    expect(await cache.ids("d")).toEqual(new Set(["c"]));
  });
  test("ties between distinct blobs use index order", async () => {
    const files = new FakeMirrorFileSystem();
    const cache = new FilePrototypeAssetCache(
      files,
      () => "/cache",
      () => 1,
      4,
    );
    await cache.put("d", upload("a", [1, 1]));
    await cache.put("d", upload("b", [2, 2]));
    await cache.put("d", upload("c", [3, 3]));
    expect(await cache.ids("d")).toEqual(new Set(["b", "c"]));
  });
  test("just-put entry survives even when its clock is older", async () => {
    const files = new FakeMirrorFileSystem();
    let clock = 3;
    const cache = new FilePrototypeAssetCache(
      files,
      () => "/cache",
      () => --clock,
      2,
    );
    await cache.put("d", upload("a"));
    await cache.put("d", upload("b", [3, 4]));
    expect(await cache.ids("d")).toEqual(new Set(["b"]));
  });
  test("queued operations serialize and detach caller-owned bytes", async () => {
    const { cache } = harness();
    const first = upload("a");
    const put = cache.put("d", first);
    first.bytes.fill(9);
    await Promise.all([put, cache.put("d", upload("b", [3, 4]))]);
    expect(await cache.ids("d")).toEqual(new Set(["a", "b"]));
    expect(await cache.get("d", "a")).toEqual(upload("a"));
  });
  test("oversize is warned and does not replace a cached id", async () => {
    const warn = silence();
    const { cache } = harness(2);
    await cache.put("d", upload());
    await cache.put("d", upload("photo", [1, 2, 3]));
    expect(await cache.get("d", "photo")).toEqual(upload());
    expect(warn).toHaveBeenCalled();
  });
  test.each(["not json", JSON.stringify({ version: 2, entries: [] })])(
    "corrupt index treated as empty: %s",
    async (content) => {
      const warn = silence();
      const { cache, files } = harness();
      await cache.put("d", upload());
      const index = [...files.files.keys()].find((file) => file.endsWith("index.json"))!;
      await files.writeFile(index, content);
      expect(await cache.ids("d")).toEqual(new Set());
      expect(warn).toHaveBeenCalled();
    },
  );
  test.each(["tampered", "missing"])("%s blob drops entry and warns", async (mode) => {
    const warn = silence();
    const { cache, files, fresh } = harness();
    await cache.put("d", upload());
    const blob = [...files.files.keys()].find((file) => file.includes("/blobs/"))!;
    if (mode === "missing") {
      await files.rm(blob);
    } else {
      await files.writeFile(blob, new Uint8Array([9, 9]));
    }
    expect(await cache.get("d", "photo")).toBeUndefined();
    expect(await fresh().ids("d")).toEqual(new Set());
    expect(warn).toHaveBeenCalled();
  });
  test("failed index write keeps prior index and does not poison serialization", async () => {
    const { cache, files } = harness();
    await cache.put("d", upload());
    const index = [...files.files.keys()].find((file) => file.endsWith("index.json"))!;
    files.failRenameTo = index;
    await expect(cache.put("d", upload("new", [3]))).rejects.toThrow("rename failed");
    expect(await cache.ids("d")).toEqual(new Set(["photo"]));
    await cache.put("d", upload("new", [3]));
    expect(await cache.ids("d")).toEqual(new Set(["photo", "new"]));
  });
});

test("recency write failure warns but returns verified bytes", async () => {
  const warn = silence();
  const { cache, files } = harness();
  await cache.put("d", upload());
  files.failWriteTo = ".tmp";
  expect(await cache.get("d", "photo")).toEqual(upload());
  expect(warn).toHaveBeenCalled();
});
test("corrupt blob cleanup write failure warns and returns missing", async () => {
  const warn = silence();
  const { cache, files } = harness();
  await cache.put("d", upload());
  const blob = [...files.files.keys()].find((file) => file.includes("/blobs/"))!;
  await files.writeFile(blob, new Uint8Array([9]));
  files.failWriteTo = ".tmp";
  expect(await cache.get("d", "photo")).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(2);
});
test.each(["put", "remove"] as const)(
  "%s propagates index EIO without modifying files",
  async (operation) => {
    silence();
    const { cache, files } = harness();
    await cache.put("d", upload());
    const before = structuredClone(files.files);
    files.failReadFrom = "index.json";
    const pending =
      operation === "put" ? cache.put("d", upload("new", [3])) : cache.remove("d", "photo");
    await expect(pending).rejects.toMatchObject({ code: "EIO" });
    expect(files.files).toEqual(before);
    await expect(cache.ids("d")).rejects.toMatchObject({ code: "EIO" });
  },
);
test("put reuses an existing blob without rewriting it", async () => {
  const { cache, files } = harness();
  await cache.put("d", upload("a"));
  const blob = [...files.files.keys()].find((file) => file.includes("/blobs/"))!;
  files.failWriteTo = blob;
  await cache.put("d", upload("b"));
  expect(await cache.ids("d")).toEqual(new Set(["a", "b"]));
});
test("new blob is staged beside its destination and failed rename preserves prior blobs", async () => {
  const { cache, files } = harness();
  await cache.put("d", upload());
  const before = structuredClone(files.files);
  const rename = spyOn(files, "rename").mockImplementation(async (from, to) => {
    expect(from).toStartWith(to + ".");
    expect(from).toEndWith(".tmp");
    expect(to).toContain("/blobs/");
    throw new Error("blob rename failed");
  });
  try {
    await expect(cache.put("d", upload("new", [3]))).rejects.toThrow("blob rename failed");
    for (const [file, bytes] of before) {
      expect(files.files.get(file)).toEqual(bytes);
    }
    expect(rename).toHaveBeenCalledTimes(1);
  } finally {
    rename.mockRestore();
  }
  await cache.put("d", upload("new", [3]));
  expect([...files.files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false);
});
test("eviction preserves an older id sharing the newly put blob", async () => {
  const { cache, files } = harness(4);
  await cache.put("d", upload("shared"));
  await cache.put("d", upload("other", [3, 4]));
  const bounded = new FilePrototypeAssetCache(
    files,
    () => "/cache",
    () => 10,
    2,
  );
  await bounded.put("d", upload("alias"));
  expect(await cache.ids("d")).toEqual(new Set(["shared", "alias"]));
});
test("index staging names use injected unique ids across cache instances", async () => {
  const files = new FakeMirrorFileSystem();
  const ids = new FakeIdGenerator();
  const first = new FilePrototypeAssetCache(
    files,
    () => "/cache",
    () => 0,
    64,
    ids,
  );
  const second = new FilePrototypeAssetCache(
    files,
    () => "/cache",
    () => 0,
    64,
    ids,
  );
  const write = spyOn(files, "writeFile");
  try {
    await first.put("d", upload());
    await second.put("d", upload());
    const stages = write.mock.calls
      .map(([file]) => file)
      .filter((file) => file.includes("index.json.") && file.endsWith(".tmp"));
    expect(stages).toHaveLength(2);
    expect(new Set(stages).size).toBe(2);
    expect(stages.every((file) => file.includes("fake-"))).toBe(true);
  } finally {
    write.mockRestore();
  }
});
