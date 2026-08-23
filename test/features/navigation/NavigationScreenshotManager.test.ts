import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import { NavigationScreenshotManager } from "../../../src/features/navigation/NavigationScreenshotManager";
import { FileSystem } from "../../../src/utils/filesystem/DefaultFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeLogger } from "../../fakes/FakeLogger";

/**
 * Normalize a path to use forward slashes for consistent comparison.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Fake file system implementation for testing NavigationScreenshotManager.
 * Uses normalized paths (forward slashes) internally for cross-platform compatibility.
 */
class FakeFileSystem implements FileSystem {
  private files: Map<string, { data: Buffer; mtimeMs: number }> = new Map();
  private directories: Set<string> = new Set();
  private readdirError: Error | null = null;
  private readFileBufferError: Error | null = null;

  private normalize(p: string): string {
    return normalizePath(p);
  }

  async ensureDir(dir: string): Promise<void> {
    this.directories.add(this.normalize(dir));
  }

  async pathExists(p: string): Promise<boolean> {
    const normalized = this.normalize(p);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async readdir(dir: string): Promise<string[]> {
    if (this.readdirError) {
      throw this.readdirError;
    }

    const normalizedDir = this.normalize(dir);
    const result: string[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(normalizedDir + "/")) {
        const filename = filePath.slice(normalizedDir.length + 1);
        if (!filename.includes("/")) {
          result.push(filename);
        }
      }
    }
    return result;
  }

  async stat(p: string): Promise<{ size: number; mtimeMs: number }> {
    const normalized = this.normalize(p);
    const file = this.files.get(normalized);
    if (!file) {
      throw new Error(`File not found: ${p}`);
    }
    return { size: file.data.length, mtimeMs: file.mtimeMs };
  }

  async readFile(p: string): Promise<string> {
    const normalized = this.normalize(p);
    const file = this.files.get(normalized);
    if (!file) {
      throw new Error(`File not found: ${p}`);
    }
    return file.data.toString("utf8");
  }

  async readFileBuffer(p: string): Promise<Buffer> {
    if (this.readFileBufferError) {
      throw this.readFileBufferError;
    }

    const normalized = this.normalize(p);
    const file = this.files.get(normalized);
    if (!file) {
      throw new Error(`File not found: ${p}`);
    }
    return file.data;
  }

  existsSync(p: string): boolean {
    const normalized = this.normalize(p);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(this.normalize(p), { data: Buffer.from(content), mtimeMs: Date.now() });
  }

  async writeFileBuffer(p: string, data: Buffer): Promise<void> {
    this.files.set(this.normalize(p), { data, mtimeMs: Date.now() });
  }

  async unlink(p: string): Promise<void> {
    this.files.delete(this.normalize(p));
  }

  async remove(p: string): Promise<void> {
    this.files.delete(this.normalize(p));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = this.normalize(oldPath);
    const normalizedNew = this.normalize(newPath);
    const file = this.files.get(normalizedOld);
    if (file) {
      this.files.set(normalizedNew, file);
      this.files.delete(normalizedOld);
    }
  }

  // Test helpers
  setFile(p: string, data: Buffer, mtimeMs?: number): void {
    this.files.set(this.normalize(p), { data, mtimeMs: mtimeMs ?? Date.now() });
  }

  getFile(p: string): Buffer | undefined {
    return this.files.get(this.normalize(p))?.data;
  }

  getFileCount(): number {
    return this.files.size;
  }

  getTotalSize(): number {
    let total = 0;
    for (const file of this.files.values()) {
      total += file.data.length;
    }
    return total;
  }

  setFileMtime(p: string, mtimeMs: number): void {
    const file = this.files.get(this.normalize(p));
    if (file) {
      file.mtimeMs = mtimeMs;
    }
  }

  failReaddir(error: Error): void {
    this.readdirError = error;
  }

  failReadFileBuffer(error: Error): void {
    this.readFileBufferError = error;
  }
}

describe("NavigationScreenshotManager", () => {
  let manager: NavigationScreenshotManager;
  let fakeFs: FakeFileSystem;
  let fakeTimer: FakeTimer;
  let fakeLogger: FakeLogger;
  const screenshotDir = "/tmp/test-screenshots";

  beforeEach(() => {
    NavigationScreenshotManager.resetInstance();
    fakeFs = new FakeFileSystem();
    fakeTimer = new FakeTimer();
    fakeLogger = new FakeLogger();

    manager = NavigationScreenshotManager.createForTesting({
      screenshotDir,
      maxCacheSizeBytes: 1024 * 1024, // 1MB for testing
      fileSystem: fakeFs,
      timer: fakeTimer,
      logger: fakeLogger,
    });
  });

  afterEach(() => {
    NavigationScreenshotManager.resetInstance();
  });

  describe("singleton pattern", () => {
    test("should return the same instance", () => {
      const instance1 = NavigationScreenshotManager.getInstance();
      const instance2 = NavigationScreenshotManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    test("should reset instance correctly", () => {
      const instance1 = NavigationScreenshotManager.getInstance();
      NavigationScreenshotManager.resetInstance();
      const instance2 = NavigationScreenshotManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("generateFilename", () => {
    test("names the file {md5(appId_screenName).slice(0,12)}_{timestamp}.webp", () => {
      const filename = manager.generateFilename("com.test.app", "HomeScreen");

      // Exact 12-char md5 prefix of "com.test.app_HomeScreen". Pinning the exact
      // hash (not merely "hex prefix") subsumes both the same-input-same-hash and
      // different-input-different-hash tautologies while also guarding the
      // hash-input string, the digest, the truncation length, and the .webp
      // extension against a filename-format change. Timestamp is 0 (fake clock).
      expect(filename).toBe("6d8c20971f5d_0.webp");
    });
  });

  describe("findExistingScreenshot", () => {
    test("should return null when no screenshots exist", async () => {
      const result = await manager.findExistingScreenshot("com.test.app", "HomeScreen");
      expect(result).toBeNull();
    });

    test("should find existing screenshot", async () => {
      // Generate a filename and create it in the fake FS
      const filename = manager.generateFilename("com.test.app", "HomeScreen");
      const expectedPath = `${screenshotDir}/${filename}`;
      fakeFs.setFile(expectedPath, Buffer.from("test"));

      const result = await manager.findExistingScreenshot("com.test.app", "HomeScreen");
      // Compare normalized paths for cross-platform compatibility
      expect(normalizePath(result!)).toBe(normalizePath(expectedPath));
    });

    test("should return most recent screenshot when multiple exist", async () => {
      const hash = manager.generateFilename("com.test.app", "HomeScreen").split("_")[0];

      // Create multiple screenshots with different timestamps
      const oldFile = `${screenshotDir}/${hash}_1000.webp`;
      const newFile = `${screenshotDir}/${hash}_2000.webp`;

      fakeFs.setFile(oldFile, Buffer.from("old"));
      fakeFs.setFile(newFile, Buffer.from("new"));

      const result = await manager.findExistingScreenshot("com.test.app", "HomeScreen");
      // Compare normalized paths for cross-platform compatibility
      expect(normalizePath(result!)).toBe(normalizePath(newFile));
    });

    test("logs directory read failures before returning null", async () => {
      fakeFs.failReaddir(new Error("directory unavailable"));
      const result = await manager.findExistingScreenshot("com.test.app", "HomeScreen");

      expect(result).toBeNull();
      expect(fakeLogger.at("debug")).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("[NAV_SCREENSHOT] Failed to find existing screenshot"),
        }),
      );
    });
  });

  describe("readScreenshot", () => {
    test("should return null for non-existent file", async () => {
      const result = await manager.readScreenshot("/nonexistent/file.webp");
      expect(result).toBeNull();
    });

    test("should return buffer for existing file", async () => {
      const path = `${screenshotDir}/test.webp`;
      const data = Buffer.from("test image data");
      fakeFs.setFile(path, data);

      const result = await manager.readScreenshot(path);
      expect(result).toEqual(data);
    });

    test("logs read failures before returning null", async () => {
      const path = `${screenshotDir}/test.webp`;
      fakeFs.setFile(path, Buffer.from("test image data"));
      fakeFs.failReadFileBuffer(new Error("read failed"));
      const result = await manager.readScreenshot(path);

      expect(result).toBeNull();
      expect(fakeLogger.at("debug")).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("[NAV_SCREENSHOT] Failed to read screenshot"),
        }),
      );
    });
  });

  describe("cleanupLRU", () => {
    test("should not delete files when under limit", async () => {
      // Create files totaling 500KB (under 1MB limit)
      const file1 = `${screenshotDir}/file1.webp`;
      const file2 = `${screenshotDir}/file2.webp`;
      fakeFs.setFile(file1, Buffer.alloc(250 * 1024));
      fakeFs.setFile(file2, Buffer.alloc(250 * 1024));

      await manager.cleanupLRU();

      expect(fakeFs.getFileCount()).toBe(2);
    });

    test("should delete oldest files when over limit", async () => {
      // Create files totaling 1.5MB (over 1MB limit)
      const oldFile = `${screenshotDir}/old.webp`;
      const newFile = `${screenshotDir}/new.webp`;

      fakeFs.setFile(oldFile, Buffer.alloc(800 * 1024), 1000);
      fakeFs.setFile(newFile, Buffer.alloc(800 * 1024), 2000);

      await manager.cleanupLRU();

      // Old file should be deleted
      expect(await fakeFs.pathExists(oldFile)).toBe(false);
      expect(await fakeFs.pathExists(newFile)).toBe(true);
    });

    test("should continue deleting until under limit", async () => {
      // Create 5 files, each 400KB (2MB total, over 1MB limit)
      for (let i = 0; i < 5; i++) {
        const file = `${screenshotDir}/file${i}.webp`;
        fakeFs.setFile(file, Buffer.alloc(400 * 1024), 1000 + i);
      }

      await manager.cleanupLRU();

      // Should delete oldest files until under 1MB
      // Need to delete at least 3 files to get under 1MB
      expect(fakeFs.getFileCount()).toBeLessThanOrEqual(2);
      expect(fakeFs.getTotalSize()).toBeLessThanOrEqual(1024 * 1024);
    });
  });

  describe("getScreenshotDir", () => {
    test("should return configured directory", () => {
      expect(manager.getScreenshotDir()).toBe(screenshotDir);
    });
  });
});
