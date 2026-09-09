import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import AdmZip from "adm-zip";
import {
  DefaultIOSCtrlProxyBundleDownloader,
  assertZipEntriesContained,
} from "../../src/utils/IOSCtrlProxyBundleDownloader";
import { defaultTimer } from "../../src/utils/SystemTimer";

describe("IOSCtrlProxyBundleDownloader zip-slip containment (#4761)", function () {
  let tempDir: string;

  beforeEach(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrl-proxy-zipslip-test-"));
  });

  afterEach(async function () {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("assertZipEntriesContained", function () {
    test("accepts entries that stay inside the destination", function () {
      const zip = new AdmZip();
      zip.addFile("Build/Products/app.txt", Buffer.from("ok"));
      zip.addFile("nested/dir/file.bin", Buffer.from("ok"));
      const destination = path.join(tempDir, "out");
      expect(() => assertZipEntriesContained(zip, destination)).not.toThrow();
    });

    test("rejects a parent-directory traversal entry", function () {
      const zip = new AdmZip();
      // adm-zip canonicalizes `../` on addFile, so a crafted archive is simulated
      // by forcing the raw traversal entryName (survives a toBuffer round-trip).
      zip.addFile("escapee.txt", Buffer.from("evil"));
      zip.getEntries()[0].entryName = "../escapee.txt";
      const destination = path.join(tempDir, "out");
      expect(() => assertZipEntriesContained(zip, destination)).toThrow(
        "zip-slip / path traversal",
      );
    });

    test("rejects a deep parent-directory traversal entry", function () {
      const zip = new AdmZip();
      zip.addFile("evil.txt", Buffer.from("evil"));
      zip.getEntries()[0].entryName = "a/../../../../etc/evil.txt";
      const destination = path.join(tempDir, "out");
      expect(() => assertZipEntriesContained(zip, destination)).toThrow(
        "zip-slip / path traversal",
      );
    });
  });

  describe("extractBundle", function () {
    test("extracts a well-formed archive into an owner-only directory", async function () {
      const zip = new AdmZip();
      zip.addFile("Build/Products/marker.txt", Buffer.from("hello"));
      const bundlePath = path.join(tempDir, "bundle.zip");
      await fs.writeFile(bundlePath, zip.toBuffer());

      const destination = path.join(tempDir, "extract");
      const downloader = new DefaultIOSCtrlProxyBundleDownloader();
      await downloader.extractBundle(bundlePath, destination);

      const extracted = await fs.readFile(
        path.join(destination, "Build", "Products", "marker.txt"),
        "utf-8",
      );
      expect(extracted).toBe("hello");
    });

    test("refuses to extract an archive with a path-traversal entry (#4761)", async function () {
      const zip = new AdmZip();
      zip.addFile("escapee.txt", Buffer.from("evil"));
      zip.getEntries()[0].entryName = "../escapee.txt";
      const bundlePath = path.join(tempDir, "malicious.zip");
      await fs.writeFile(bundlePath, zip.toBuffer());

      const destination = path.join(tempDir, "extract");
      const downloader = new DefaultIOSCtrlProxyBundleDownloader();

      await expect(downloader.extractBundle(bundlePath, destination)).rejects.toThrow(
        "zip-slip / path traversal",
      );

      // The traversal target must not have been written to the parent directory.
      await expect(fs.access(path.join(tempDir, "escapee.txt"))).rejects.toThrow();
    });

    test("does not block the event loop during extraction (#6574)", async function () {
      const zip = new AdmZip();
      for (let i = 0; i < 30; i++) {
        zip.addFile(`Build/Products/file-${i}.bin`, Buffer.from("x".repeat(20_000)));
      }
      const bundlePath = path.join(tempDir, "bundle.zip");
      await fs.writeFile(bundlePath, zip.toBuffer());

      const destination = path.join(tempDir, "extract");
      const downloader = new DefaultIOSCtrlProxyBundleDownloader();

      // Real wall-clock timer (not a fake): this test proves actual OS-thread
      // yielding, which a logical/fake clock cannot observe.
      let ticks = 0;
      const interval = defaultTimer.setInterval(() => {
        ticks++;
      }, 1);

      try {
        await downloader.extractBundle(bundlePath, destination);
      } finally {
        defaultTimer.clearInterval(interval);
      }

      // A macrotask timer scheduled before extractBundle must get a chance to
      // run WHILE extraction is in flight, proving the main event loop was
      // never monopolized by synchronous decompress/write work (issue #6574).
      expect(ticks).toBeGreaterThan(0);
    });
  });
});
