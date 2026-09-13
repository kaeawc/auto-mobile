import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import os from "os";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { FileSystemObserveCacheStore } from "../../../../src/features/observe/cache/FileSystemObserveCacheStore";
import type { ObserveResultCacheStore } from "../../../../src/features/observe/cache/ObserveResultCacheStore";
import { FakeObserveCacheStore } from "../../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { ObserveResult } from "../../../../src/models";

function makeResult(label: string): ObserveResult {
  return {
    updatedAt: label,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

/**
 * The fake is the required seam for tests that scope a screenshot to the device
 * that produced the most recent observation (issue #6600). Under a FakeTimer,
 * two puts routinely land on the SAME tick, so the tie-break is not an edge case
 * there — it is the common case. If the fake and the production store disagree
 * about which device wins a tie, every such test validates the wrong device.
 */
describe("getRecentInMemoryEntry same-tick tie-break parity", function () {
  let cacheDir: string;
  let timer: FakeTimer;
  let stores: Array<{ name: string; store: ObserveResultCacheStore }>;

  beforeEach(function () {
    cacheDir = path.join(os.tmpdir(), `observe-cache-parity-${randomUUID()}`);
    mkdirSync(cacheDir, { recursive: true });
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    stores = [
      {
        name: "FileSystemObserveCacheStore",
        store: new FileSystemObserveCacheStore(timer, cacheDir),
      },
      { name: "FakeObserveCacheStore", store: new FakeObserveCacheStore(timer) },
    ];
  });

  afterEach(function () {
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("both stores return the LAST device cached on a shared timestamp", async function () {
    const first = makeResult("device-a");
    const second = makeResult("device-b");

    for (const { name, store } of stores) {
      await store.put("device-a", first);
      await store.put("device-b", second);

      const entry = store.getRecentInMemoryEntry();

      expect(`${name}:${entry?.deviceId}`).toBe(`${name}:device-b`);
      expect(entry?.result).toBe(second);
    }
  });

  test("both stores still prefer a strictly newer entry over an older one", async function () {
    const older = makeResult("older");
    const newer = makeResult("newer");

    for (const { name, store } of stores) {
      await store.put("device-a", older);
      timer.advanceTime(5);
      await store.put("device-b", newer);
      timer.setCurrentTime(1_000_000);

      const entry = store.getRecentInMemoryEntry();

      expect(`${name}:${entry?.deviceId}`).toBe(`${name}:device-b`);
      expect(entry?.result).toBe(newer);
    }
  });
});
