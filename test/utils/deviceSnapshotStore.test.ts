import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

describe("DeviceSnapshotStore", () => {
  let store: DeviceSnapshotStore;
  let testBasePath: string;

  beforeEach(async () => {
    testBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-store-test-"));
    store = new DeviceSnapshotStore(testBasePath);
    await store.ensureSnapshotsDirectory();
  });

  afterEach(async () => {
    try {
      await fs.rm(testBasePath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it("should default to the ~/.auto-mobile/snapshots base path", () => {
    const defaultStore = new DeviceSnapshotStore();
    expect(defaultStore.getBasePath()).toBe(path.join(os.homedir(), ".auto-mobile", "snapshots"));
    // Guard against regressing to the historical hyphen-less ".automobile" typo,
    // which orphaned snapshot state from the rest of ~/.auto-mobile (issue #5706).
    expect(defaultStore.getBasePath()).not.toContain(path.join(".automobile", "snapshots"));
  });

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
    it("replaces existing contents so no stale files survive", async () => {
      const snapshotName = "replace-me";
      const dest = store.getSnapshotPath(snapshotName);
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "stale.txt"), "old");

      const result = await store.replaceSnapshotData(snapshotName, undefined, async () => {
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(path.join(dest, "fresh.txt"), "new");
        return "captured";
      });

      expect(result).toBe("captured");
      const entries = await fs.readdir(dest);
      expect(entries.sort()).toEqual(["fresh.txt"]);
      // The set-aside copy must be cleaned up on success.
      expect(await store.snapshotDirectoryExists(`${snapshotName}.replacing`)).toBe(false);
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
    });

    it("captures cleanly when no prior snapshot exists", async () => {
      const snapshotName = "brand-new";
      const dest = store.getSnapshotPath(snapshotName);

      await store.replaceSnapshotData(snapshotName, undefined, async () => {
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(path.join(dest, "data.txt"), "value");
      });

      expect(await store.snapshotDirectoryExists(snapshotName)).toBe(true);
      expect(await fs.readFile(path.join(dest, "data.txt"), "utf-8")).toBe("value");
      expect(await store.snapshotDirectoryExists(`${snapshotName}.replacing`)).toBe(false);
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
});
