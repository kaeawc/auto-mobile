import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";

describe("DeviceSnapshotStore real fsync integration", () => {
  let basePath: string;
  let store: DeviceSnapshotStore;

  beforeEach(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-store-integration-"));
    store = new DeviceSnapshotStore(basePath);
    await store.ensureSnapshotsDirectory();
  });

  afterEach(async () => {
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it("overwrites an existing snapshot with real file and directory fsyncs", async () => {
    const name = "replace-me";
    const snapshotPath = store.getSnapshotPath(name);
    await fs.mkdir(snapshotPath, { recursive: true });
    await fs.writeFile(path.join(snapshotPath, "stale.txt"), "old");

    await store.replaceSnapshotData(name, undefined, async () => {
      await fs.mkdir(snapshotPath, { recursive: true });
      await fs.writeFile(path.join(snapshotPath, "fresh.txt"), "new");
    });

    expect(await fs.readdir(snapshotPath)).toEqual(["fresh.txt"]);
    expect(await fs.readFile(path.join(snapshotPath, "fresh.txt"), "utf-8")).toBe("new");
    expect(await fs.readdir(basePath)).toEqual([name]);
  });
});
