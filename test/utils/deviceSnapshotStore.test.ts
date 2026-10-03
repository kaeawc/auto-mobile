import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  DeviceSnapshotStore,
  findReservedSnapshotNameReason,
  isReservedSnapshotName,
  SNAPSHOT_REPLACING_SUFFIX,
  SNAPSHOT_IOS_SCOPE_ROOT,
  SNAPSHOT_ANDROID_SCOPE_ROOT,
} from "../../src/utils/DeviceSnapshotStore";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "../../src/utils/logger";
import {
  noOpSnapshotDirectorySync,
  noOpSnapshotFileSync,
} from "../helpers/deviceSnapshotStoreSync";

describe("reserved snapshot names", () => {
  for (const snapshotName of [
    ".replacing",
    ".REPLACING",
    ".Replacing",
    "x.journal.replacing",
    "x.JOURNAL.REPLACING",
    "x.journal.tmp.replacing",
    "android",
    "ANDROID",
    "Ios",
  ]) {
    it(`reserves ${snapshotName} case-insensitively`, () => {
      expect(isReservedSnapshotName(snapshotName)).toBe(true);
      expect(findReservedSnapshotNameReason(snapshotName)).toEqual(
        snapshotName.toLowerCase().endsWith(SNAPSHOT_REPLACING_SUFFIX)
          ? { kind: "suffix", suffix: SNAPSHOT_REPLACING_SUFFIX }
          : { kind: "scope-root", name: snapshotName.toLowerCase() },
      );
    });
  }

  for (const snapshotName of [
    "x.journal",
    "x.tmp",
    "a.journal.b",
    "a.replacing.b",
    "androidx",
    "my-ios",
  ]) {
    it(`allows ordinary name ${snapshotName}`, () => {
      expect(isReservedSnapshotName(snapshotName)).toBe(false);
      expect(findReservedSnapshotNameReason(snapshotName)).toBeUndefined();
    });
  }
});

describe("DeviceSnapshotStore", () => {
  let store: DeviceSnapshotStore;
  let testBasePath: string;

  beforeEach(async () => {
    testBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-store-test-"));
    store = new DeviceSnapshotStore(testBasePath, noOpSnapshotDirectorySync, noOpSnapshotFileSync);
    await store.ensureSnapshotsDirectory();
  });

  afterEach(async () => {
    try {
      await fs.rm(testBasePath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  for (const envKey of ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR"]) {
    it(`resolves the default snapshot path lazily from ${envKey} and preserves overrides`, () => {
      const originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
      const originalLegacyDataDir = process.env.AUTO_MOBILE_DATA_DIR;
      try {
        delete process.env.AUTOMOBILE_DATA_DIR;
        delete process.env.AUTO_MOBILE_DATA_DIR;
        process.env[envKey] = testBasePath;
        expect(new DeviceSnapshotStore().getBasePath()).toBe(path.join(testBasePath, "snapshots"));
        expect(store.getBasePath()).toBe(testBasePath);

        process.env[envKey] = path.join(testBasePath, "another-root");
        expect(new DeviceSnapshotStore().getBasePath()).toBe(
          path.join(testBasePath, "another-root", "snapshots"),
        );
      } finally {
        if (originalDataDir === undefined) {
          delete process.env.AUTOMOBILE_DATA_DIR;
        } else {
          process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
        }
        if (originalLegacyDataDir === undefined) {
          delete process.env.AUTO_MOBILE_DATA_DIR;
        } else {
          process.env.AUTO_MOBILE_DATA_DIR = originalLegacyDataDir;
        }
      }
    });
  }

  describe("generateSnapshotName", () => {
    it("should generate a snapshot name with timestamp", () => {
      const name = store.generateSnapshotName();
      expect(name).toMatch(/^snapshot_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
    });

    it("should include device name when provided", () => {
      const name = store.generateSnapshotName("Pixel_5");
      expect(name).toMatch(/^Pixel_5_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
    });

    it("should sanitize device names with special characters", () => {
      const name = store.generateSnapshotName("Pixel 5 (API 30)");
      expect(name).toMatch(/^Pixel_5__API_30__\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
    });
  });

  it("should return correct snapshot paths", () => {
    expect(store.getSnapshotPath("test-snapshot")).toBe(path.join(testBasePath, "test-snapshot"));
    expect(store.getSettingsPath("test-snapshot")).toBe(
      path.join(testBasePath, "test-snapshot", "settings.json"),
    );
    expect(store.getMetadataPath("test-snapshot")).toBe(
      path.join(testBasePath, "test-snapshot", "metadata.json"),
    );
    expect(store.getAppDataPath("test-snapshot")).toBe(
      path.join(testBasePath, "test-snapshot", "app_data"),
    );
  });

  it("should return iOS snapshot paths scoped by device", () => {
    const options = { platform: "ios", deviceId: "SIM-UDID" };
    expect(store.getSnapshotPathWithOptions("test-snapshot", options)).toBe(
      path.join(testBasePath, "ios", "SIM-UDID", "test-snapshot"),
    );
    expect(store.getMetadataPath("test-snapshot", options)).toBe(
      path.join(testBasePath, "ios", "SIM-UDID", "test-snapshot", "metadata.json"),
    );
    expect(store.getAppDataPath("test-snapshot", options)).toBe(
      path.join(testBasePath, "ios", "SIM-UDID", "test-snapshot", "app-data"),
    );
  });

  it("should return Android snapshot paths scoped by AVD name (#5707)", () => {
    const options = { platform: "android" as const, avdName: "Pixel_5" };
    expect(store.getSnapshotPathWithOptions("test-snapshot", options)).toBe(
      path.join(testBasePath, "android", "Pixel_5", "test-snapshot"),
    );
    expect(store.getSettingsPath("test-snapshot", options)).toBe(
      path.join(testBasePath, "android", "Pixel_5", "test-snapshot", "settings.json"),
    );
    expect(store.getMetadataPath("test-snapshot", options)).toBe(
      path.join(testBasePath, "android", "Pixel_5", "test-snapshot", "metadata.json"),
    );
    expect(store.getAppDataPath("test-snapshot", options)).toBe(
      path.join(testBasePath, "android", "Pixel_5", "test-snapshot", "app_data"),
    );
  });

  it("falls back to the unscoped path for Android without an AVD name (physical device) (#5707)", () => {
    const options = { platform: "android" as const };
    expect(store.getSnapshotPathWithOptions("test-snapshot", options)).toBe(
      path.join(testBasePath, "test-snapshot"),
    );
  });

  it("isolates same-named Android snapshots across two AVDs on disk (#5707)", async () => {
    const snapshotName = "shared-name";
    const avdA = { platform: "android" as const, avdName: "Pixel_5" };
    const avdB = { platform: "android" as const, avdName: "Pixel_7" };

    // Capture "shared-name" on AVD A only.
    await fs.mkdir(store.getSnapshotPathWithOptions(snapshotName, avdA), { recursive: true });

    // AVD A sees it; AVD B does not — the name is reusable across devices.
    expect(await store.snapshotDirectoryExists(snapshotName, avdA)).toBe(true);
    expect(await store.snapshotDirectoryExists(snapshotName, avdB)).toBe(false);

    // Deleting AVD B's (nonexistent) snapshot must not remove AVD A's data.
    await store.deleteSnapshotData(snapshotName, avdB);
    expect(await store.snapshotDirectoryExists(snapshotName, avdA)).toBe(true);

    // Deleting AVD A's snapshot removes only AVD A's data.
    await store.deleteSnapshotData(snapshotName, avdA);
    expect(await store.snapshotDirectoryExists(snapshotName, avdA)).toBe(false);
  });

  it("should detect snapshot directories", async () => {
    const snapshotName = "snapshot-exists";
    expect(await store.snapshotDirectoryExists(snapshotName)).toBe(false);

    await fs.mkdir(store.getSnapshotPath(snapshotName), { recursive: true });
    expect(await store.snapshotDirectoryExists(snapshotName)).toBe(true);
  });

  it("should delete snapshot data", async () => {
    const snapshotName = "snapshot-delete";
    await fs.mkdir(store.getSnapshotPath(snapshotName), { recursive: true });
    expect(await store.snapshotDirectoryExists(snapshotName)).toBe(true);

    await store.deleteSnapshotData(snapshotName);
    expect(await store.snapshotDirectoryExists(snapshotName)).toBe(false);
  });

  describe("replaceSnapshotData (#5713)", () => {
    const journal = (dest: string) => `${dest}.journal.replacing`;
    const tempJournal = (dest: string) => `${dest}.journal.tmp.replacing`;

    it("reserves the real journal, temp journal, aside, and scope-root path names", async () => {
      const originalRename = fs.rename.bind(fs);
      const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        expect(isReservedSnapshotName(path.basename(String(destination)))).toBe(true);
        if (String(source).endsWith(".journal.tmp.replacing")) {
          // Observe the actual temp journal before the store renames it.
          expect(["pending-existing", "committed"]).toContain(await fs.readFile(source, "utf-8"));
          expect(isReservedSnapshotName(path.basename(String(source)))).toBe(true);
        }
        await originalRename(source, destination);
      });
      try {
        for (const snapshotName of ["normal", "x.journal", "Mixed"]) {
          const dest = store.getSnapshotPath(snapshotName);
          await fs.mkdir(dest);
          await store.replaceSnapshotData(snapshotName, undefined, async () => {
            const entries = await fs.readdir(testBasePath);
            const bookkeepingNames = entries.filter((entry) => entry !== snapshotName);
            expect(bookkeepingNames).toContain(path.basename(journal(dest)));
            expect(bookkeepingNames).toContain(path.basename(`${dest}.replacing`));
            expect(isReservedSnapshotName(path.basename(journal(dest)))).toBe(true);
            expect(isReservedSnapshotName(path.basename(`${dest}.replacing`))).toBe(true);
            await fs.mkdir(dest);
          });
          await fs.rm(dest, { recursive: true });
        }
        expect(renameSpy).toHaveBeenCalledTimes(9);
      } finally {
        renameSpy.mockRestore();
      }

      for (const options of [
        { platform: "ios" as const, deviceId: "device" },
        { platform: "android" as const, avdName: "avd" },
      ]) {
        const scopedPath = store.getSnapshotPathWithOptions("normal", options);
        const rootName = path.basename(path.dirname(path.dirname(scopedPath)));
        expect(rootName).toBe(
          options.platform === "ios" ? SNAPSHOT_IOS_SCOPE_ROOT : SNAPSHOT_ANDROID_SCOPE_ROOT,
        );
        expect(isReservedSnapshotName(rootName)).toBe(true);
      }
    });

    it("replaces existing contents so no stale files survive", async () => {
      const snapshotName = "replace-me";
      const dest = store.getSnapshotPath(snapshotName);
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "stale.txt"), "old");

      const result = await store.replaceSnapshotData(snapshotName, undefined, async () => {
        expect(await fs.readFile(journal(dest), "utf-8")).toBe("pending-existing");
        expect(await fs.readFile(path.join(`${dest}.replacing`, "stale.txt"), "utf-8")).toBe("old");
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(path.join(dest, "fresh.txt"), "new");
        return "captured";
      });

      expect(result).toBe("captured");
      const entries = await fs.readdir(dest);
      expect(entries.sort()).toEqual(["fresh.txt"]);
      // The set-aside copy must be cleaned up on success.
      expect(await store.snapshotDirectoryExists(`${snapshotName}.replacing`)).toBe(false);
      expect(await fs.readdir(testBasePath)).toEqual([snapshotName]);
    });

    it("syncs journal files before rename and the parent directory after rename", async () => {
      const name = "sync-order";
      const events: string[] = [];
      const originalRename = fs.rename.bind(fs);
      const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        events.push(
          String(source).endsWith(".journal.tmp.replacing") ? "rename-journal" : "rename-other",
        );
        await originalRename(source, destination);
      });
      const recordingStore = new DeviceSnapshotStore(
        testBasePath,
        async () => {
          events.push("sync-directory");
        },
        async () => {
          events.push("sync-file");
        },
      );

      try {
        await recordingStore.replaceSnapshotData(name, undefined, async () => {
          await fs.mkdir(recordingStore.getSnapshotPath(name));
        });
      } finally {
        renameSpy.mockRestore();
      }

      const journalRenameIndexes = events.flatMap((event, index) =>
        event === "rename-journal" ? [index] : [],
      );
      expect(journalRenameIndexes.length).toBe(2);
      for (const index of journalRenameIndexes) {
        expect(events[index - 1]).toBe("sync-file");
        expect(events[index + 1]).toBe("sync-directory");
      }
    });

    for (const code of ["EPERM", "EINVAL", "EISDIR", "ENOTSUP"]) {
      it(`replaces a snapshot when directory sync reports ${code}`, async () => {
        const name = "unsupported-directory-sync";
        const dest = path.join(testBasePath, name);
        await fs.mkdir(dest);
        await fs.writeFile(path.join(dest, "old.txt"), "old");
        const syncPaths: string[] = [];
        const syncFailure = Object.assign(new Error("directory sync unsupported"), { code });
        const storeWithSyncFailure = new DeviceSnapshotStore(
          testBasePath,
          async (dirPath) => {
            syncPaths.push(dirPath);
            throw syncFailure;
          },
          noOpSnapshotFileSync,
        );

        await storeWithSyncFailure.replaceSnapshotData(name, undefined, async () => {
          await fs.mkdir(dest);
          await fs.writeFile(path.join(dest, "new.txt"), "new");
        });

        expect(syncPaths.length).toBeGreaterThan(0);
        expect(syncPaths).toEqual(Array(syncPaths.length).fill(testBasePath));
        expect(await fs.readdir(dest)).toEqual(["new.txt"]);
        expect(await fs.readdir(testBasePath)).toEqual([name]);
      });
    }

    it("propagates EIO from directory sync", async () => {
      const syncFailure = Object.assign(new Error("directory sync failed"), { code: "EIO" });
      const storeWithSyncFailure = new DeviceSnapshotStore(
        testBasePath,
        async () => {
          throw syncFailure;
        },
        noOpSnapshotFileSync,
      );

      await expect(
        storeWithSyncFailure.replaceSnapshotData("failed-sync", undefined, async () => {
          throw new Error("capture should not run");
        }),
      ).rejects.toBe(syncFailure);
    });

    it("propagates ENOENT from directory sync after moving an existing snapshot", async () => {
      const name = "existing-sync-failure";
      await fs.mkdir(path.join(testBasePath, name));
      const syncFailure = Object.assign(new Error("directory sync failed"), { code: "ENOENT" });
      let syncCalls = 0;
      const storeWithSyncFailure = new DeviceSnapshotStore(
        testBasePath,
        async () => {
          syncCalls++;
          if (syncCalls === 2) {
            throw syncFailure;
          }
        },
        noOpSnapshotFileSync,
      );

      await expect(
        storeWithSyncFailure.replaceSnapshotData(name, undefined, async () => {
          throw new Error("capture should not run");
        }),
      ).rejects.toBe(syncFailure);
      expect(syncCalls).toBe(2);
    });

    it("restores the prior snapshot when the capture fails", async () => {
      const snapshotName = "keep-on-failure";
      const dest = store.getSnapshotPath(snapshotName);
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "original.txt"), "keep");

      await expect(
        store.replaceSnapshotData(snapshotName, undefined, async () => {
          await fs.mkdir(dest, { recursive: true });
          await fs.writeFile(path.join(dest, "partial.txt"), "garbage");
          throw new Error("capture blew up");
        }),
      ).rejects.toThrow("capture blew up");

      // Prior data is restored; the partial capture is discarded.
      const entries = await fs.readdir(dest);
      expect(entries.sort()).toEqual(["original.txt"]);
      expect(await fs.readFile(path.join(dest, "original.txt"), "utf-8")).toBe("keep");
      expect(await store.snapshotDirectoryExists(`${snapshotName}.replacing`)).toBe(false);
      expect(await fs.readdir(testBasePath)).toEqual([snapshotName]);
    });

    it("captures cleanly when no prior snapshot exists", async () => {
      const snapshotName = "brand-new";
      const dest = store.getSnapshotPath(snapshotName);

      await store.replaceSnapshotData(snapshotName, undefined, async () => {
        expect(await fs.readFile(journal(dest), "utf-8")).toBe("pending-new");
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(path.join(dest, "data.txt"), "value");
      });

      expect(await store.snapshotDirectoryExists(snapshotName)).toBe(true);
      expect(await fs.readFile(path.join(dest, "data.txt"), "utf-8")).toBe("value");
      expect(await store.snapshotDirectoryExists(`${snapshotName}.replacing`)).toBe(false);
      expect(await fs.readdir(testBasePath)).toEqual([snapshotName]);
    });

    it("restores an interrupted overwrite before the next capture", async () => {
      const name = "interrupted";
      const dest = store.getSnapshotPath(name);
      await fs.mkdir(`${dest}.replacing`);
      await fs.writeFile(path.join(`${dest}.replacing`, "old.txt"), "old");
      await fs.mkdir(dest);
      await fs.writeFile(path.join(dest, "partial.txt"), "partial");
      await fs.writeFile(journal(dest), "pending-existing");

      await store.replaceSnapshotData(name, undefined, async () => {
        expect(await fs.readFile(path.join(`${dest}.replacing`, "old.txt"), "utf-8")).toBe("old");
        expect(await store.snapshotDirectoryExists(name)).toBe(false);
        await fs.mkdir(dest);
        await fs.writeFile(path.join(dest, "new.txt"), "new");
      });

      expect(await fs.readdir(dest)).toEqual(["new.txt"]);
      expect(await fs.readdir(testBasePath)).toEqual([name]);
    });

    it("restores old data from an uncommitted journal at startup", async () => {
      const name = "startup-recovery";
      const dest = store.getSnapshotPath(name);
      await fs.mkdir(`${dest}.replacing`);
      await fs.writeFile(path.join(`${dest}.replacing`, "old.txt"), "old");
      await fs.mkdir(dest);
      await fs.writeFile(path.join(dest, "partial.txt"), "partial");
      await fs.writeFile(journal(dest), "pending-existing");

      expect((await store.listSubdirectoryNames(testBasePath))?.sort()).toEqual([
        name,
        `${name}.replacing`,
      ]);
      await new DeviceSnapshotStore(
        testBasePath,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      ).recoverSnapshotData(name);

      expect(await fs.readdir(dest)).toEqual(["old.txt"]);
      expect(await fs.readdir(testBasePath)).toEqual([name]);
    });

    it("keeps a committed destination and removes its stale aside", async () => {
      const name = "committed";
      const dest = store.getSnapshotPath(name);
      await fs.mkdir(dest);
      await fs.writeFile(path.join(dest, "new.txt"), "new");
      await fs.mkdir(`${dest}.replacing`);
      await fs.writeFile(path.join(`${dest}.replacing`, "old.txt"), "old");
      await fs.writeFile(journal(dest), "committed");

      await new DeviceSnapshotStore(
        testBasePath,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      ).recoverSnapshotData(name);

      expect(await fs.readFile(path.join(dest, "new.txt"), "utf-8")).toBe("new");
      expect(await fs.readdir(testBasePath)).toEqual([name]);
    });

    it("removes an orphan temp journal without changing the snapshot", async () => {
      const name = "temp-orphan";
      const dest = store.getSnapshotPath(name);
      await fs.mkdir(dest);
      await fs.writeFile(path.join(dest, "old.txt"), "old");
      await fs.writeFile(tempJournal(dest), "pending-existing");

      expect(await store.listSubdirectoryNames(testBasePath)).toEqual([name]);

      await store.recoverSnapshotData(name);

      expect(await fs.readFile(path.join(dest, "old.txt"), "utf-8")).toBe("old");
      expect(await fs.readdir(testBasePath)).toEqual([name]);
    });

    it("discards an interrupted first capture with no previous copy", async () => {
      const name = "new-interrupted";
      const dest = store.getSnapshotPath(name);
      await fs.mkdir(dest);
      await fs.writeFile(path.join(dest, "partial.txt"), "partial");
      await fs.writeFile(journal(dest), "pending-new");

      await store.recoverSnapshotData(name);

      expect(await fs.readdir(testBasePath)).toEqual([]);
    });

    it("removes a legacy unjournaled aside when the destination exists", async () => {
      const name = "legacy-committed";
      const dest = store.getSnapshotPath(name);
      await fs.mkdir(dest);
      await fs.writeFile(path.join(dest, "new.txt"), "new");
      await fs.mkdir(`${dest}.replacing`);
      await fs.writeFile(path.join(`${dest}.replacing`, "old.txt"), "old");

      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await store.recoverSnapshotData(name);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("Removing legacy set-aside"));
      } finally {
        warning.mockRestore();
      }

      expect(await fs.readFile(path.join(dest, "new.txt"), "utf-8")).toBe("new");
      expect(await fs.readdir(testBasePath)).toEqual([name]);
    });

    it("restores a legacy unjournaled aside when the destination is missing", async () => {
      const name = "legacy-interrupted";
      const dest = store.getSnapshotPath(name);
      await fs.mkdir(`${dest}.replacing`);
      await fs.writeFile(path.join(`${dest}.replacing`, "old.txt"), "old");

      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await store.recoverSnapshotData(name);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("Restoring legacy set-aside"));
      } finally {
        warning.mockRestore();
      }

      expect(await fs.readFile(path.join(dest, "old.txt"), "utf-8")).toBe("old");
      expect(await fs.readdir(testBasePath)).toEqual([name]);
    });
  });

  it("should compute snapshot size", async () => {
    const snapshotName = "snapshot-size";
    const snapshotDir = store.getSnapshotPath(snapshotName);
    await fs.mkdir(snapshotDir, { recursive: true });
    const filePath = path.join(snapshotDir, "sample.txt");
    await fs.writeFile(filePath, "hello");

    const size = await store.getSnapshotSizeBytes(snapshotName);
    expect(size).toBe(5);
  });

  it("returns zero for a snapshot archive that was never captured", async () => {
    expect(await store.getSnapshotSizeBytes("does-not-exist")).toBe(0);
  });

  it("returns unknown when the snapshot archive cannot be read", async () => {
    const readdirSpy = spyOn(fs, "readdir").mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    try {
      expect(await store.getSnapshotSizeBytes("unreadable")).toBeNull();
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("returns null when a nested snapshot entry vanishes during size measurement", async () => {
    const snapshotName = "partially-unreadable";
    const snapshotDir = store.getSnapshotPath(snapshotName);
    const nestedDir = path.join(snapshotDir, "nested");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(nestedDir, "payload.bin"), "large payload");

    const readdir = fs.readdir.bind(fs);
    let removedNestedDirectory = false;
    const readdirSpy = spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const entries = await readdir(...args);
      if (args[0] === snapshotDir && !removedNestedDirectory) {
        removedNestedDirectory = true;
        await fs.rm(nestedDir, { recursive: true });
      }
      return entries;
    });

    try {
      expect(await store.getSnapshotSizeBytes(snapshotName)).toBeNull();
    } finally {
      readdirSpy.mockRestore();
    }
  });

  describe("getDirectorySize / listSubdirectoryNames (#6490)", () => {
    it("distinguishes a missing directory (null) from an empty one (0)", async () => {
      const emptyDir = path.join(testBasePath, "empty");
      await fs.mkdir(emptyDir, { recursive: true });

      expect(await store.getDirectorySize(emptyDir)).toBe(0);
      expect(await store.getDirectorySize(path.join(testBasePath, "does-not-exist"))).toBeNull();
    });

    it("measures an arbitrary directory recursively, so an in-AVD payload can be sized", async () => {
      // Shaped like ~/.android/avd/<avd>.avd/snapshots/<name>.
      const snapshotDir = path.join(testBasePath, "fake-avd.avd", "snapshots", "snap");
      await fs.mkdir(path.join(snapshotDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(snapshotDir, "ram.bin"), "0123456789");
      await fs.writeFile(path.join(snapshotDir, "nested", "textures.bin"), "abc");

      expect(await store.getDirectorySize(snapshotDir)).toBe(13);
    });

    it("returns null when a nested directory vanishes during recursive measurement", async () => {
      const snapshotDir = path.join(testBasePath, "snapshot");
      const nestedDir = path.join(snapshotDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(snapshotDir, "ram.bin"), "0123456789");
      await fs.writeFile(path.join(nestedDir, "textures.bin"), "abc");

      const readdir = fs.readdir.bind(fs);
      let removedNestedDirectory = false;
      const readdirSpy = spyOn(fs, "readdir").mockImplementation(async (...args) => {
        const entries = await readdir(...args);
        if (args[0] === snapshotDir && !removedNestedDirectory) {
          removedNestedDirectory = true;
          await fs.rm(nestedDir, { recursive: true });
        }
        return entries;
      });

      try {
        expect(await store.getDirectorySize(snapshotDir)).toBeNull();
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it("lists only subdirectories, and reports null for a missing directory", async () => {
      const snapshotsRoot = path.join(testBasePath, "snapshots-root");
      await fs.mkdir(path.join(snapshotsRoot, "default_boot"), { recursive: true });
      await fs.mkdir(path.join(snapshotsRoot, "sweepSnap"), { recursive: true });
      await fs.writeFile(path.join(snapshotsRoot, "not-a-dir.txt"), "x");

      expect((await store.listSubdirectoryNames(snapshotsRoot))?.sort()).toEqual([
        "default_boot",
        "sweepSnap",
      ]);
      expect(await store.listSubdirectoryNames(path.join(testBasePath, "nope"))).toBeNull();
    });

    it("lists only files, so a relocated AVD's `<name>.ini` registry is visible", async () => {
      // Shaped like ~/.android/avd: one conventional AVD directory next to the
      // registry file a relocated AVD leaves behind (#6490 review).
      const avdHome = path.join(testBasePath, "avd-home");
      await fs.mkdir(path.join(avdHome, "am-api34.avd"), { recursive: true });
      await fs.writeFile(path.join(avdHome, "am-api34.ini"), "path=/x");
      await fs.writeFile(path.join(avdHome, "am-relocated.ini"), "path=/y");

      expect((await store.listFileNames(avdHome))?.sort()).toEqual([
        "am-api34.ini",
        "am-relocated.ini",
      ]);
      expect(await store.listFileNames(path.join(testBasePath, "nope"))).toBeNull();
    });
  });
});
