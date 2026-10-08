import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { UNIT_TEST_ISOLATED_DATA_DIR_ENV, Window } from "../../../src/features/observe/Window";
import type { BootedDevice } from "../../../src/models";
import { NodeCryptoService } from "../../../src/utils/crypto";
import { TEMP_SUBDIRS } from "../../../src/utils/tempDir";
import { isolateCliDataDir, type IsolatedCliDataDir } from "../../helpers/cliDataDirIsolation";
import { createTapAt } from "../../helpers/tapAtCoordinate";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Cache guard device",
  platform: "android",
};
const cachedWindow = { appId: "com.seeded.app", activityName: ".Main", layoutSeqSum: 17 };

describe("Window disk cache unit-test guard", () => {
  let isolation: IsolatedCliDataDir;
  let adb: FakeAdbExecutor;

  beforeEach(() => {
    isolation = isolateCliDataDir("automobile-window-guard-");
    adb = new FakeAdbExecutor();
  });

  afterEach(() => isolation.restore());

  function cachePath(dataDir: string): string {
    return path.join(
      dataDir,
      TEMP_SUBDIRS.WINDOW,
      NodeCryptoService.generateCacheKey(device.deviceId),
    );
  }

  async function seed(dataDir: string): Promise<void> {
    await fs.mkdir(path.join(dataDir, TEMP_SUBDIRS.WINDOW), { recursive: true });
    await fs.writeFile(cachePath(dataDir), JSON.stringify(cachedWindow), "utf-8");
  }

  function createWindow(env: NodeJS.ProcessEnv, homeDir = isolation.dataDir): Window {
    return new Window(device, new FakeAdbClientFactory(adb), undefined, env, homeDir);
  }

  for (const override of ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR"]) {
    test(`reads the device-hashed disk cache with explicit ${override}`, async () => {
      await seed(isolation.dataDir);
      const read = spyOn(fs, "readFile");
      try {
        const window = createWindow({ NODE_ENV: "test", [override]: isolation.dataDir });
        expect(await window.getCachedActiveWindow()).toEqual(cachedWindow);
        expect(await window.getActive()).toEqual(cachedWindow);
        expect(read).toHaveBeenCalledWith(cachePath(isolation.dataDir), "utf-8");
        expect(adb.getExecutedCommands()).toEqual([]);
      } finally {
        read.mockRestore();
      }
    });

    test(`preserves disk writes and deletion with explicit ${override}`, async () => {
      const window = createWindow({ NODE_ENV: "test", [override]: isolation.dataDir });
      await window.setCachedActiveWindow(cachedWindow);
      expect(JSON.parse(await fs.readFile(cachePath(isolation.dataDir), "utf-8"))).toEqual(
        cachedWindow,
      );
      expect(
        await createWindow({
          NODE_ENV: "test",
          [override]: isolation.dataDir,
        }).getCachedActiveWindow(),
      ).toEqual(cachedWindow);
      await window.clearCache();
      expect(existsSync(cachePath(isolation.dataDir))).toBe(false);
      expect(await window.getCachedActiveWindow()).toBeNull();
    });
  }

  test("does not read a seeded default cache under an injected home", async () => {
    const defaultDir = path.join(isolation.dataDir, ".auto-mobile");
    await seed(defaultDir);
    const read = spyOn(fs, "readFile");
    try {
      const window = createWindow({ NODE_ENV: "test" });
      expect(await window.getCachedActiveWindow()).toBeNull();
      await window.getActive();
      expect(read).not.toHaveBeenCalled();
      expect(adb.getExecutedCommands()).toContain('shell "dumpsys window windows"');
    } finally {
      read.mockRestore();
    }
  });

  test("keeps memory caching while skipping all default-dir disk mutations", async () => {
    const mkdir = spyOn(fs, "mkdir");
    const write = spyOn(fs, "writeFile");
    const unlink = spyOn(fs, "unlink");
    try {
      const window = createWindow({ NODE_ENV: "test" });
      await window.setCachedActiveWindow(cachedWindow);
      expect(await window.getCachedActiveWindow()).toEqual(cachedWindow);
      expect(await window.getActive()).toEqual(cachedWindow);
      expect(adb.getExecutedCommands()).toEqual([]);
      await window.clearCache();
      expect(await window.getCachedActiveWindow()).toBeNull();
      await window.getActive(true);
      expect(mkdir).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(existsSync(path.join(isolation.dataDir, ".auto-mobile"))).toBe(false);
    } finally {
      mkdir.mockRestore();
      write.mockRestore();
      unlink.mockRestore();
    }
  });

  test("the data directory the test preload assigned does not opt into the disk cache", async () => {
    await seed(isolation.dataDir);
    const mkdir = spyOn(fs, "mkdir");
    const write = spyOn(fs, "writeFile");
    try {
      for (const override of ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR"]) {
        const window = createWindow({
          NODE_ENV: "test",
          [override]: isolation.dataDir,
          [UNIT_TEST_ISOLATED_DATA_DIR_ENV]: isolation.dataDir,
        });
        expect(await window.getCachedActiveWindow()).toBeNull();
        await window.setCachedActiveWindow(cachedWindow);
        expect(await window.getCachedActiveWindow()).toEqual(cachedWindow);
      }
      expect(mkdir).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      write.mockRestore();
    }
  });

  test("a test's own data directory still opts in beside the preload's", async () => {
    await seed(isolation.dataDir);
    const window = createWindow({
      NODE_ENV: "test",
      AUTOMOBILE_DATA_DIR: isolation.dataDir,
      [UNIT_TEST_ISOLATED_DATA_DIR_ENV]: path.join(isolation.dataDir, "preload"),
    });
    expect(await window.getCachedActiveWindow()).toEqual(cachedWindow);
  });

  test("empty or whitespace overrides do not opt into the default disk cache", async () => {
    await seed(path.join(isolation.dataDir, ".auto-mobile"));
    for (const value of ["", "   "]) {
      for (const key of ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR"]) {
        expect(
          await createWindow({ NODE_ENV: "test", [key]: value }).getCachedActiveWindow(),
        ).toBeNull();
      }
    }
  });

  test("matches resolver precedence when the primary override is empty", async () => {
    await seed(path.join(isolation.dataDir, ".auto-mobile"));
    const window = createWindow({
      NODE_ENV: "test",
      AUTOMOBILE_DATA_DIR: "",
      AUTO_MOBILE_DATA_DIR: isolation.dataDir,
    });
    expect(await window.getCachedActiveWindow()).toBeNull();
  });

  test("preserves production disk caching without an override", async () => {
    const dataDir = path.join(isolation.dataDir, ".auto-mobile");
    await seed(dataDir);
    const window = createWindow({ NODE_ENV: "production" });
    expect(await window.getCachedActiveWindow()).toEqual(cachedWindow);
    const updated = { ...cachedWindow, layoutSeqSum: 99 };
    await window.setCachedActiveWindow(updated);
    expect(JSON.parse(await fs.readFile(cachePath(dataDir), "utf-8"))).toEqual(updated);
    await window.clearCache();
    expect(existsSync(cachePath(dataDir))).toBe(false);
  });

  test("a shared-helper action ignores a seeded default cache and issues no gfxinfo commands", async () => {
    await seed(path.join(isolation.dataDir, ".auto-mobile"));
    const { tapAt, androidDispatches } = createTapAt(device, 100, 100);
    // Retain the real Window while injecting an isolated home and recording adb.
    tapAt.window = createWindow({ NODE_ENV: "test" });
    const actionAdb = Reflect.get(tapAt, "adb") as FakeAdbExecutor;
    expect((await tapAt.execute({ x: 20, y: 30 })).success).toBe(true);
    expect(androidDispatches).toHaveLength(1);
    expect(
      actionAdb.getExecutedCommands().filter((command) => command.includes("gfxinfo")),
    ).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
