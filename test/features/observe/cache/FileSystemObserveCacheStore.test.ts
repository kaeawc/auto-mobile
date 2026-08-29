import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import os from "os";
import { mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
