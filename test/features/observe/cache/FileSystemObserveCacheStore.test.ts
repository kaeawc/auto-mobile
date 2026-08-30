import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import os from "os";
import { mkdirSync, rmSync, readdirSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAsync } from "../../../../src/utils/io";
import {
  FileSystemObserveCacheStore,
  OBSERVE_RESULT_CACHE_TTL_MS,
  normalizeCachedObserveResult,
} from "../../../../src/features/observe/cache/FileSystemObserveCacheStore";
import { capLayoutWarnings } from "../../../../src/features/observe/audits/SafeAreaAuditor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { ObserveResult } from "../../../../src/models";

function makeResult(label: string): ObserveResult {
  return {
    updatedAt: label,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

describe("FileSystemObserveCacheStore", function () {
  let cacheDir: string;
  let timer: FakeTimer;
  let store: FileSystemObserveCacheStore;

  beforeEach(function () {
    cacheDir = path.join(os.tmpdir(), `observe-cache-test-${randomUUID()}`);
    mkdirSync(cacheDir, { recursive: true });
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    store = new FileSystemObserveCacheStore(timer, cacheDir);
  });

  afterEach(function () {
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("creates the cache directory on construction if missing", function () {
    const fresh = path.join(os.tmpdir(), `observe-cache-fresh-${randomUUID()}`);
    expect(existsSync(fresh)).toBe(false);
    new FileSystemObserveCacheStore(timer, fresh);
    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  });

  test("put then getRecentInMemoryForDevice returns the cached result", async function () {
    const result = makeResult("a");
    await store.put("device-1", result);
    expect(store.getRecentInMemoryForDevice("device-1")).toBe(result);
  });

  test("put then getRecentInMemory (cross-device) returns the latest result", async function () {
    const older = makeResult("older");
    const newer = makeResult("newer");
    await store.put("device-1", older);
    timer.advanceTime(10);
    await store.put("device-2", newer);
    expect(store.getRecentInMemory()).toBe(newer);
  });

  test("TTL: entry older than 5 minutes is evicted from memory on read", async function () {
    const result = makeResult("expired");
    await store.put("device-1", result);
    timer.advanceTime(OBSERVE_RESULT_CACHE_TTL_MS + 1);
    expect(store.getRecentInMemoryForDevice("device-1")).toBeUndefined();
    expect(store.getRecentInMemory()).toBeUndefined();
  });

  test("multi-device isolation: getRecentInMemoryForDevice returns only matching device", async function () {
    const r1 = makeResult("d1");
    const r2 = makeResult("d2");
    await store.put("device-1", r1);
    timer.advanceTime(5);
    await store.put("device-2", r2);
    expect(store.getRecentInMemoryForDevice("device-1")).toBe(r1);
    expect(store.getRecentInMemoryForDevice("device-2")).toBe(r2);
  });

  test("disk fallback: getMostRecent restores from disk after memory clear", async function () {
    const result = makeResult("on-disk");
    await store.put("device-1", result);

    // Drop the in-memory cache by constructing a fresh store backed by the same disk dir.
    const reloadedTimer = new FakeTimer();
    reloadedTimer.setCurrentTime(timer.now() + 1); // 1ms later so file is still within TTL
    const reloaded = new FileSystemObserveCacheStore(reloadedTimer, cacheDir);
    expect(reloaded.getRecentInMemoryForDevice("device-1")).toBeUndefined();
    const restored = await reloaded.getMostRecent("device-1");
    expect(restored).toBeDefined();
    expect(restored?.updatedAt).toBe("on-disk");
    // After getMostRecent, the entry should now be warm in memory.
    expect(reloaded.getRecentInMemoryForDevice("device-1")).toBeDefined();
  });

  test("clear(deviceId) only removes entries for that device", async function () {
    await store.put("device-1", makeResult("d1"));
    timer.advanceTime(1);
    await store.put("device-2", makeResult("d2"));

    store.clear("device-1");
    expect(store.getRecentInMemoryForDevice("device-1")).toBeUndefined();
    expect(store.getRecentInMemoryForDevice("device-2")).toBeDefined();
  });

  test("clear() removes everything in memory", async function () {
    await store.put("device-1", makeResult("d1"));
    timer.advanceTime(1);
    await store.put("device-2", makeResult("d2"));

    store.clear();
    expect(store.getRecentInMemory()).toBeUndefined();
    expect(store.getRecentInMemoryForDevice("device-1")).toBeUndefined();
    expect(store.getRecentInMemoryForDevice("device-2")).toBeUndefined();
  });

  test("currentGeneration starts at 0 and is stable across reads", function () {
    expect(store.currentGeneration("device-1")).toBe(0);
    expect(store.currentGeneration("device-1")).toBe(0);
    expect(store.currentGeneration("device-2")).toBe(0);
  });

  test("clear(deviceId) bumps only that device's generation", function () {
    store.clear("device-1");
    expect(store.currentGeneration("device-1")).toBe(1);
    expect(store.currentGeneration("device-2")).toBe(0);
    store.clear("device-1");
    expect(store.currentGeneration("device-1")).toBe(2);
  });

  test("clear() (all devices) bumps every device's generation", function () {
    expect(store.currentGeneration("device-1")).toBe(0);
    expect(store.currentGeneration("device-2")).toBe(0);
    store.clear();
    expect(store.currentGeneration("device-1")).toBe(1);
    expect(store.currentGeneration("device-2")).toBe(1);
  });

  test("put with the current generation stores normally", async function () {
    const gen = store.currentGeneration("device-1");
    await store.put("device-1", makeResult("fresh"), gen);
    expect(store.getRecentInMemoryForDevice("device-1")).toBeDefined();
  });

  test("put with no generation stores unconditionally (back-compat)", async function () {
    store.clear("device-1"); // advance generation
    await store.put("device-1", makeResult("no-gen"));
    expect(store.getRecentInMemoryForDevice("device-1")).toBeDefined();
  });

  test("put with a stale generation is rejected (race: invalidate then late put)", async function () {
    // An observation captures the generation at its start...
    const capturedGen = store.currentGeneration("device-1");
    // ...a concurrent terminate invalidates the device cache mid-flight...
    store.clear("device-1");
    // ...and the in-flight observation's put lands afterwards with the stale gen.
    await store.put("device-1", makeResult("stale-app-hierarchy"), capturedGen);

    // The stale record must not repopulate the cache (memory and disk).
    expect(store.getRecentInMemoryForDevice("device-1")).toBeUndefined();
    expect(await store.getMostRecent("device-1")).toBeUndefined();
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length).toBe(0);
  });

  test("put is rejected when clear() interleaves mid-write (in-flight put, not just pre-put)", async function () {
    const capturedGen = store.currentGeneration("device-1");
    // Start the put but do not await it: its body runs synchronously up to the
    // internal `await this.pendingDiskCleanup`, then yields with the generation
    // still current. A clear() landing in that hop must still fence the write.
    const putPromise = store.put("device-1", makeResult("stale-mid-write"), capturedGen);
    store.clear("device-1");
    await putPromise;

    expect(store.getRecentInMemoryForDevice("device-1")).toBeUndefined();
    expect(await store.getMostRecent("device-1")).toBeUndefined();
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length).toBe(0);
  });

  test("put with a stale generation from clear-all is rejected", async function () {
    const capturedGen = store.currentGeneration("device-1");
    store.clear();
    await store.put("device-1", makeResult("stale"), capturedGen);
    expect(store.getRecentInMemoryForDevice("device-1")).toBeUndefined();
  });

  test("put writes a JSON file with the sanitized device id in the name", async function () {
    await store.put("emulator-5554:abcd", makeResult("with-colon"));
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    expect(files[0]).toContain("emulator-5554_abcd");
    expect(files[0]).not.toContain(":");
  });

  test("getMostRecent returns undefined when nothing cached", async function () {
    const result = await store.getMostRecent("device-1");
    expect(result).toBeUndefined();
  });

  test("getMostRecent reaps expired disk files while scanning", async function () {
    const expiredFiles = [
      `observe_device-1_${timer.now()}_g0.json`,
      `observe_device-1_${timer.now()}_g1.json`,
    ];
    const expiredAt = timer.now() - OBSERVE_RESULT_CACHE_TTL_MS - 1;
    for (const file of expiredFiles) {
      const filePath = path.join(cacheDir, file);
      writeFileSync(filePath, JSON.stringify(makeResult("expired")));
      utimesSync(filePath, new Date(expiredAt), new Date(expiredAt));
    }

    const currentFile = `observe_device-1_${timer.now()}_g0-current.json`;
    const currentPath = path.join(cacheDir, currentFile);
    writeFileSync(currentPath, JSON.stringify(makeResult("current")));
    utimesSync(currentPath, new Date(timer.now()), new Date(timer.now()));

    const restored = await store.getMostRecent("device-1");

    expect(restored?.updatedAt).toBe("current");
    expect(expiredFiles.every((file) => !existsSync(path.join(cacheDir, file)))).toBe(true);
    expect(existsSync(currentPath)).toBe(true);
  });

  // --- Generation-stamped disk files (#5892) -------------------------------

  test("put stamps the write generation into the disk filename", async function () {
    await store.put("device-1", makeResult("g0"), store.currentGeneration("device-1"));
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/_g0\.json$/);
  });

  test("put stamps the current generation even for an unconditional write", async function () {
    store.clear("device-1"); // generation -> 1
    await store.put("device-1", makeResult("no-gen")); // unconditional
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/_g1\.json$/);
  });

  test("getMostRecent skips a disk file stamped with a stale generation and does not warm memory (Residual 2)", async function () {
    // Advance the device generation so a g0-stamped file is provably stale.
    store.clear("device-1"); // currentGeneration("device-1") === 1
    // A stale file slipped onto disk (e.g. a clear() that landed mid disk-write,
    // per Residual 1) stamped with the pre-clear generation 0.
    const staleName = `observe_device-1_${timer.now()}_g0.json`;
    writeFileSync(path.join(cacheDir, staleName), JSON.stringify(makeResult("stale-hierarchy")));

    expect(await store.getMostRecent("device-1")).toBeUndefined();
    expect(store.getRecentInMemoryForDevice("device-1")).toBeUndefined();
  });

  test("getMostRecent serves a disk file stamped with the current generation", async function () {
    store.clear("device-1"); // generation -> 1
    const currentName = `observe_device-1_${timer.now()}_g1.json`;
    writeFileSync(path.join(cacheDir, currentName), JSON.stringify(makeResult("current")));

    const restored = await store.getMostRecent("device-1");
    expect(restored?.updatedAt).toBe("current");
  });

  test("getMostRecent still serves a legacy disk file with no generation stamp (cross-restart back-compat)", async function () {
    store.clear("device-1"); // generation -> 1
    // Pre-#5892 filename format (or a file from another process instance): no
    // generation stamp. We cannot prove it stale, so it must still be served.
    const legacyName = `observe_device-1_${timer.now()}.json`;
    writeFileSync(path.join(cacheDir, legacyName), JSON.stringify(makeResult("legacy")));

    const restored = await store.getMostRecent("device-1");
    expect(restored?.updatedAt).toBe("legacy");
  });

  test("a clear() landing during the disk write cleans up the stale file (Residual 1)", async function () {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const gatedWriter = async (filePath: string, data: string): Promise<void> => {
      writes += 1;
      await gate;
      await writeFileAsync(filePath, data);
    };
    const gatedStore = new FileSystemObserveCacheStore(timer, cacheDir, gatedWriter);

    const gen = gatedStore.currentGeneration("device-1");
    const putPromise = gatedStore.put("device-1", makeResult("mid-write"), gen);

    // Let put() progress until it parks at the gated write.
    while (writes === 0) {
      await Promise.resolve();
    }

    // A concurrent terminate invalidates the device while the write is in flight.
    gatedStore.clear("device-1");
    release();
    await putPromise;

    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length).toBe(0);
    expect(gatedStore.getRecentInMemoryForDevice("device-1")).toBeUndefined();
  });

  test("clear() followed immediately by put() does not delete the fresh file", async function () {
    // Seed an existing entry so clear() has something to delete.
    await store.put("device-1", makeResult("stale"));
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length).toBe(1);

    // Advance the clock so the fresh write gets a different filename than the
    // stale one — otherwise the keys collide and the cleanup deletes the
    // overwritten file (a separate concern from the race).
    timer.setCurrentTime(1_000_001);

    // Race: clear() then immediate put(). The fire-and-forget cleanup must not
    // race against the fresh write and delete it.
    store.clear("device-1");
    await store.put("device-1", makeResult("fresh"));

    // Drain the microtask queue so any in-flight unlinks resolve. The snapshot
    // taken inside clear() should NOT include the post-clear write, so the
    // file count must settle at exactly one.
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    // The surviving file must be the fresh one, not the stale one.
    const restored = await store.getMostRecent("device-1");
    expect(restored?.updatedAt).toBe("fresh");
  });
});

describe("normalizeCachedObserveResult — legacy layoutWarnings migration (#5074)", function () {
  // A pre-#5074 daemon wrote layoutWarnings as an array plus a sibling number.
  const warning = {
    type: "important-content-under-inset",
    severity: "info",
    element: { bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
  };

  test("wraps a legacy array + layoutWarningsTruncated into a truncated envelope", function () {
    const result = normalizeCachedObserveResult({
      updatedAt: "x",
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      layoutWarnings: [warning],
      layoutWarningsTruncated: 150,
    });
    expect(result.layoutWarnings).toEqual({
      scope: "truncated",
      total: 150,
      warnings: [warning],
    } as never);
    expect((result as Record<string, unknown>).layoutWarningsTruncated).toBeUndefined();
  });

  test("wraps a legacy array with no truncation as a full envelope", function () {
    const result = normalizeCachedObserveResult({
      updatedAt: "x",
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      layoutWarnings: [warning],
    });
    expect(result.layoutWarnings).toEqual({ scope: "full", warnings: [warning] } as never);
  });

  test("passes a modern envelope through unchanged", function () {
    const envelope = { scope: "full" as const, warnings: [warning] };
    const result = normalizeCachedObserveResult({
      updatedAt: "x",
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      layoutWarnings: envelope,
    });
    expect(result.layoutWarnings).toBe(envelope as never);
  });

  test("a normalized legacy result no longer throws when capped (regression: #5074 finding 7)", function () {
    const many = Array.from({ length: 150 }, () => warning);
    const result = normalizeCachedObserveResult({
      updatedAt: "x",
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      layoutWarnings: many,
    });
    expect(() => capLayoutWarnings(result.layoutWarnings!)).not.toThrow();
    expect(capLayoutWarnings(result.layoutWarnings!).warnings).toHaveLength(100);
  });
});
