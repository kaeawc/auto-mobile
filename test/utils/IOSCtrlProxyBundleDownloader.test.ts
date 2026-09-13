import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import AdmZip from "adm-zip";
import {
  DefaultIOSCtrlProxyBundleDownloader,
  assertZipEntriesContained,
} from "../../src/utils/IOSCtrlProxyBundleDownloader";
import { EventEmitter } from "node:events";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ExtractBundleWorker } from "../../src/utils/IOSCtrlProxyBundleDownloader";

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

    test("dispatches extraction and waits for worker completion independently of the main timer", async function () {
      const timer = new FakeTimer();
      class FakeWorker extends EventEmitter {
        terminated = false;
        async terminate(): Promise<number> {
          this.terminated = true;
          return 0;
        }
      }
      const worker = new FakeWorker();
      let dispatched!: () => void;
      const dispatch = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      const destination = path.join(tempDir, "extract");
      const bundlePath = path.join(tempDir, "bundle.zip");
      const downloader = new DefaultIOSCtrlProxyBundleDownloader(undefined, undefined, (data) => {
        expect(data).toEqual({ bundlePath, destination });
        dispatched();
        return worker as ExtractBundleWorker;
      });
      let completed = false;
      const extraction = downloader.extractBundle(bundlePath, destination).then(() => {
        completed = true;
      });
      await dispatch;
      let ticked = false;
      timer.setTimeout(() => {
        ticked = true;
      }, 1);
      timer.advanceTime(1);
      expect(ticked).toBe(true);
      expect(completed).toBe(false);
      worker.emit("message", { ok: true });
      await extraction;
      expect(completed).toBe(true);
      expect(worker.terminated).toBe(true);
    });

    test.each([0, 1])("rejects worker exit without a result (code %s)", async function (code) {
      const worker = new EventEmitter() as EventEmitter & ExtractBundleWorker;
      worker.terminate = async () => 0;
      const downloader = new DefaultIOSCtrlProxyBundleDownloader(undefined, undefined, () => {
        queueMicrotask(() => worker.emit("exit", code));
        return worker;
      });
      await expect(
        downloader.extractBundle("unused.zip", path.join(tempDir, "out")),
      ).rejects.toThrow("without a result");
    });

    test("handles worker termination rejection", async function () {
      const worker = new EventEmitter() as EventEmitter & ExtractBundleWorker;
      worker.terminate = async () => {
        throw new Error("termination failed");
      };
      const downloader = new DefaultIOSCtrlProxyBundleDownloader(undefined, undefined, () => {
        queueMicrotask(() => worker.emit("message", { ok: true }));
        return worker;
      });
      await expect(
        downloader.extractBundle("unused.zip", path.join(tempDir, "out")),
      ).rejects.toThrow("termination failed");
    });
  });
});
