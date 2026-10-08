import { loggerCallsWithPrefix } from "../helpers/loggerCallsWithPrefix";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs, type Dirent } from "fs";
import * as os from "os";
import * as path from "path";
import { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";
import { logger } from "../../src/utils/logger";
import { sortedReaddir } from "../../src/utils/io";
import {
  noOpSnapshotDirectorySync,
  noOpSnapshotFileSync,
} from "../helpers/deviceSnapshotStoreSync";

const LIMITS = { maxEntries: 50, maxScopeDirectories: 64 };

function syntheticDirent(parentPath: string, name: string, directory = false): Dirent {
  return {
    name,
    parentPath,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

describe("snapshot journal enumeration and discard", () => {
  let root: string;
  let store: DeviceSnapshotStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-journal-list-"));
    store = new DeviceSnapshotStore(root, noOpSnapshotDirectorySync, noOpSnapshotFileSync);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function artifact(relativePath: string, directory = false): Promise<void> {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (directory) {
      await fs.mkdir(fullPath);
    } else {
      await fs.writeFile(fullPath, "pending-new");
    }
  }

  test("maps all three artifact suffixes in flat, Android and iOS scopes and deduplicates", async () => {
    for (const prefix of ["", "android/Pixel/", "ios/UDID/"]) {
      for (const name of [
        "aside.replacing",
        "journal.journal.replacing",
        "temp.journal.tmp.replacing",
        "aside.journal.replacing",
        "aside.journal.tmp.replacing",
      ]) {
        await artifact(`${prefix}${name}`, name === "aside.replacing");
      }
    }
    const { entries, truncated } = await store.listLeftoverSnapshotJournals(LIMITS);
    expect(entries).toEqual([
      ...["aside", "journal", "temp"].map((snapshotName) => ({ snapshotName, options: undefined })),
      ...["aside", "journal", "temp"].map((snapshotName) => ({
        snapshotName,
        options: { platform: "android", avdName: "Pixel" },
      })),
      ...["aside", "journal", "temp"].map((snapshotName) => ({
        snapshotName,
        options: { platform: "ios", deviceId: "UDID" },
      })),
    ]);
    expect(truncated).toBe(false);
  });

  test("skips reserved flat roots and unsafe names/scopes without entering payloads", async () => {
    await artifact("android.replacing", true);
    await artifact("ios.journal.tmp.replacing");
    await artifact(".replacing");
    await artifact("..replacing");
    await artifact("ordinary/nested.replacing");
    await artifact("android/Pixel/ordinary/nested.journal.replacing");
    await artifact("ios/UDID/ordinary/nested.replacing");
    const readdir = fs.readdir.bind(fs);
    // Backslashes are path separators on Windows, so inject these names instead of creating them.
    const read = spyOn(fs, "readdir").mockImplementation(async (directory, options) => {
      if (options && typeof options === "object" && options.withFileTypes === true) {
        const entries = await readdir(directory, options);
        if (directory === root) {
          return [...entries, syntheticDirent(root, "bad\\name.replacing")];
        }
        if (directory === path.join(root, "android")) {
          return [...entries, syntheticDirent(directory, "bad\\scope", true)];
        }
        return entries;
      }
      return readdir(directory, options);
    });
    try {
      expect(await store.listLeftoverSnapshotJournals(LIMITS)).toEqual({
        entries: [],
        truncated: false,
      });
      expect(read.mock.calls.map(([directory]) => directory)).toEqual([
        root,
        path.join(root, "android"),
        path.join(root, "android", "Pixel"),
        path.join(root, "ios"),
        path.join(root, "ios", "UDID"),
      ]);
    } finally {
      read.mockRestore();
    }
  });

  test("bounds entries in deterministic sorted order", async () => {
    await artifact("z.replacing");
    await artifact("b.replacing");
    await artifact("a.replacing");
    expect(await store.listLeftoverSnapshotJournals({ ...LIMITS, maxEntries: 2 })).toEqual({
      entries: [
        { snapshotName: "a", options: undefined },
        { snapshotName: "b", options: undefined },
      ],
      truncated: true,
    });
  });

  test("shares the scope-directory bound across sorted Android and iOS scopes", async () => {
    await artifact("android/Z/last.replacing");
    await artifact("android/A/first.replacing");
    await artifact("ios/A/ios.replacing");
    const read = spyOn(fs, "readdir");
    try {
      expect(
        await store.listLeftoverSnapshotJournals({ ...LIMITS, maxScopeDirectories: 2 }),
      ).toEqual({
        entries: [
          { snapshotName: "first", options: { platform: "android", avdName: "A" } },
          { snapshotName: "last", options: { platform: "android", avdName: "Z" } },
        ],
        truncated: true,
      });
      expect(read.mock.calls.map(([directory]) => directory)).not.toContain(
        path.join(root, "ios", "A"),
      );
    } finally {
      read.mockRestore();
    }
  });

  test("does not follow symlink platform roots or scope directories", async () => {
    await artifact("payload/hidden.replacing");
    await fs.symlink(path.join(root, "payload"), path.join(root, "android"), "dir");
    await fs.mkdir(path.join(root, "ios"));
    await fs.symlink(path.join(root, "payload"), path.join(root, "ios", "link"), "dir");
    expect(await store.listLeftoverSnapshotJournals(LIMITS)).toEqual({
      entries: [],
      truncated: false,
    });
  });

  test("clean and missing roots yield no entries and make no directories or writes", async () => {
    const mkdir = spyOn(fs, "mkdir");
    const rm = spyOn(fs, "rm");
    try {
      expect(await store.listLeftoverSnapshotJournals(LIMITS)).toEqual({
        entries: [],
        truncated: false,
      });
      const missing = new DeviceSnapshotStore(path.join(root, "missing"));
      expect(await missing.listLeftoverSnapshotJournals(LIMITS)).toEqual({
        entries: [],
        truncated: false,
      });
      expect(mkdir).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      mkdir.mockRestore();
      rm.mockRestore();
    }
  });

  test("discard removes all artifacts while preserving the snapshot's own data", async () => {
    await artifact("android/Pixel/save.replacing", true);
    await artifact("android/Pixel/save.journal.replacing");
    await artifact("android/Pixel/save.journal.tmp.replacing");
    await artifact("android/Pixel/save/payload");
    expect(
      await store.discardSnapshotArtifacts("save", { platform: "android", avdName: "Pixel" }),
    ).toEqual([]);
    expect(await fs.readdir(path.join(root, "android", "Pixel"))).toEqual(["save"]);
    expect(await fs.readFile(path.join(root, "android", "Pixel", "save", "payload"), "utf8")).toBe(
      "pending-new",
    );
  });

  test("discard reports each failed path and continues removing the other artifacts", async () => {
    for (const name of ["save.replacing", "save.journal.replacing", "save.journal.tmp.replacing"]) {
      await artifact(name);
    }
    const failurePaths = [
      path.join(root, "save.replacing"),
      path.join(root, "save.journal.tmp.replacing"),
    ];
    const remove = fs.rm.bind(fs);
    const failure = new Error("permission denied");
    const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (failurePaths.includes(String(target))) {
        throw failure;
      }
      return remove(target, options);
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await store.discardSnapshotArtifacts("save")).toEqual(failurePaths);
      const warnings = loggerCallsWithPrefix(
        warning.mock.calls,
        "Failed to discard snapshot artifact ",
      );
      expect(warnings).toHaveLength(2);
      expect(warnings.map((call) => call[1])).toEqual([failure, failure]);
      expect(await sortedReaddir(root)).toEqual(["save.journal.tmp.replacing", "save.replacing"]);
    } finally {
      rm.mockRestore();
      warning.mockRestore();
    }
  });
});
