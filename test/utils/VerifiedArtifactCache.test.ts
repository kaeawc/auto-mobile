import { beforeEach, describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import {
  type VerifiedArtifactDownload,
  type VerifiedArtifactFileSystem,
  VerifiedArtifactCache,
} from "../../src/utils/VerifiedArtifactCache";
import type { FileDownloader } from "../../src/utils/FileDownloader";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";
import { FakeTimer } from "../fakes/FakeTimer";

const SHA = "a".repeat(64);

class MemoryFileSystem implements VerifiedArtifactFileSystem {
  files = new Map<string, string>();
  modes = new Map<string, number | undefined>();
  removed: string[] = [];
  failRemove = false;
  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async writeText(path: string, content: string, mode?: number): Promise<void> {
    this.files.set(path, content);
    this.modes.set(path, mode);
  }
  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error(`ENOENT: ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, content);
  }
  async remove(path: string): Promise<void> {
    if (this.failRemove) {
      throw new Error("remove failed");
    }
    this.removed.push(path);
    this.files.delete(path);
  }
}

class MemoryDownloader implements FileDownloader {
  calls: Array<{ url: string; destination: string; signal?: AbortSignal }> = [];
  failure: Error | null = null;
  hang = false;
  constructor(private readonly fs: MemoryFileSystem) {}
  async download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ url, destination, signal });
    if (this.failure) {
      throw this.failure;
    }
    if (this.hang) {
      await new Promise<void>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    this.fs.files.set(destination, "payload");
  }
}

describe("VerifiedArtifactCache", () => {
  let fs: MemoryFileSystem;
  let downloader: MemoryDownloader;
  let checksum: FakeChecksumCalculator;
  let timer: FakeTimer;
  let cache: VerifiedArtifactCache;
  let published: string[];

  const request = (
    overrides: Partial<VerifiedArtifactDownload> = {},
  ): VerifiedArtifactDownload => ({
    label: "[TEST]",
    expectedSha256: SHA,
    url: "https://example.test/asset.zip",
    archivePath: "/cache/asset.download",
    metadataPath: "/cache/meta.json",
    mismatchError: (want, actual) => new ActionableError(`mismatch ${want} ${actual}`),
    publish: async (archive, sha256) => {
      published.push(archive);
      return { sha256, size: 7 };
    },
    ...overrides,
  });

  beforeEach(() => {
    fs = new MemoryFileSystem();
    downloader = new MemoryDownloader(fs);
    checksum = new FakeChecksumCalculator();
    checksum.checksum = SHA;
    timer = new FakeTimer();
    published = [];
    cache = new VerifiedArtifactCache({
      downloader,
      checksumCalculator: checksum,
      fileSystem: fs,
      timer,
    });
  });

  const lookup = (verifyArtifact: () => Promise<boolean> = async () => true) => ({
    label: "[TEST]",
    subject: "asset",
    expectedSha256: SHA,
    metadataPath: "/cache/meta.json",
    parseMetadata: (value: unknown) =>
      typeof value === "object" && value !== null && "sha256" in value
        ? (value as { sha256: string })
        : null,
    verifyArtifact,
  });

  describe("isCached", () => {
    test("misses without a sidecar", async () => {
      expect(await cache.isCached(lookup())).toBe(false);
    });

    test("misses on corrupt JSON or an unexpected schema", async () => {
      fs.files.set("/cache/meta.json", "{nope");
      expect(await cache.isCached(lookup())).toBe(false);
      fs.files.set("/cache/meta.json", "[]");
      expect(await cache.isCached(lookup())).toBe(false);
    });

    test("misses when the recorded sha differs", async () => {
      fs.files.set("/cache/meta.json", JSON.stringify({ sha256: "b".repeat(64) }));
      expect(await cache.isCached(lookup())).toBe(false);
    });

    test("compares shas case-insensitively and defers to the artifact check", async () => {
      fs.files.set("/cache/meta.json", JSON.stringify({ sha256: SHA.toUpperCase() }));
      expect(await cache.isCached(lookup())).toBe(true);
      expect(await cache.isCached(lookup(async () => false))).toBe(false);
    });
  });

  describe("fetch", () => {
    test("downloads, verifies, publishes and writes the sidecar", async () => {
      await cache.fetch(request({ metadataMode: 0o600 }));

      expect(downloader.calls.map((call) => call.url)).toEqual(["https://example.test/asset.zip"]);
      expect(checksum.computedFiles).toEqual(["/cache/asset.download"]);
      expect(published).toEqual(["/cache/asset.download"]);
      expect(JSON.parse(fs.files.get("/cache/meta.json")!)).toEqual({ sha256: SHA, size: 7 });
      expect(fs.modes.get("/cache/meta.json")).toBe(0o600);
    });

    test("a checksum mismatch never publishes and removes the archive", async () => {
      checksum.checksum = "c".repeat(64);
      await expect(cache.fetch(request())).rejects.toThrow(/mismatch/);
      expect(published).toEqual([]);
      expect(fs.files.has("/cache/meta.json")).toBe(false);
      expect(fs.files.has("/cache/asset.download")).toBe(false);
    });

    test("runs afterDownload before hashing, then discard and settle on failure", async () => {
      const order: string[] = [];
      const original = checksum.computeFileSha256.bind(checksum);
      checksum.computeFileSha256 = async (file) => {
        order.push("hash");
        return original(file);
      };
      checksum.checksum = "c".repeat(64);
      await expect(
        cache.fetch(
          request({
            afterDownload: async () => void order.push("after"),
            discard: async () => void order.push("discard"),
            settle: async () => void order.push("settle"),
          }),
        ),
      ).rejects.toThrow();
      expect(order).toEqual(["after", "hash", "discard", "settle"]);
    });

    test("a publish failure writes no sidecar and still discards and removes the archive", async () => {
      let discarded = false;
      await expect(
        cache.fetch(
          request({
            publish: async () => {
              throw new Error("publish failed");
            },
            discard: async () => void (discarded = true),
          }),
        ),
      ).rejects.toThrow("publish failed");
      expect(fs.files.has("/cache/meta.json")).toBe(false);
      expect(fs.removed).toContain("/cache/asset.download");
      expect(discarded).toBe(true);
    });

    test("the sidecar is written only after publish, and a write failure discards", async () => {
      let sidecarSeenDuringPublish = true;
      fs.writeText = async () => {
        throw new Error("disk full");
      };
      let discarded = false;
      await expect(
        cache.fetch(
          request({
            publish: async (_archive, sha256) => {
              sidecarSeenDuringPublish = fs.files.has("/cache/meta.json");
              return { sha256 };
            },
            discard: async () => void (discarded = true),
          }),
        ),
      ).rejects.toThrow("disk full");
      expect(sidecarSeenDuringPublish).toBe(false);
      expect(discarded).toBe(true);
    });

    test("compares the downloaded sha case-insensitively", async () => {
      checksum.checksum = SHA.toUpperCase();
      await cache.fetch(request());
      expect(published).toHaveLength(1);
    });

    test("without a pinned sha the hash is skipped and publish sees null", async () => {
      let seen: unknown = "unset";
      await cache.fetch(
        request({
          expectedSha256: null,
          publish: async (_archive, sha256) => {
            seen = sha256;
          },
        }),
      );
      expect(seen).toBeNull();
      expect(checksum.computedFiles).toEqual([]);
    });

    test("an empty pin fails closed instead of skipping verification", async () => {
      await expect(cache.fetch(request({ expectedSha256: "" }))).rejects.toThrow(/mismatch/);
      expect(published).toEqual([]);
    });

    test("without a metadataPath no sidecar is written", async () => {
      await cache.fetch(request({ metadataPath: undefined }));
      expect(fs.files.has("/cache/meta.json")).toBe(false);
    });

    test("finalPath receives the verified archive atomically", async () => {
      await cache.fetch(request({ finalPath: "/cache/asset" }));
      expect(fs.files.get("/cache/asset")).toBe("payload");
      expect(fs.files.has("/cache/asset.download")).toBe(false);
    });

    test("a failed download or verification never touches an existing finalPath", async () => {
      fs.files.set("/cache/asset", "old-good");
      checksum.checksum = "c".repeat(64);
      await expect(cache.fetch(request({ finalPath: "/cache/asset" }))).rejects.toThrow(/mismatch/);
      expect(fs.files.get("/cache/asset")).toBe("old-good");

      downloader.failure = new Error("network down");
      await expect(cache.fetch(request({ finalPath: "/cache/asset" }))).rejects.toThrow(
        "network down",
      );
      expect(fs.files.get("/cache/asset")).toBe("old-good");
    });

    test("settle also runs on success", async () => {
      let settled = false;
      await cache.fetch(request({ settle: async () => void (settled = true) }));
      expect(settled).toBe(true);
    });

    test("a download timeout surfaces the timeout error and cleans up", async () => {
      downloader.hang = true;
      const pending = cache.fetch(
        request({
          downloadTimeoutMs: 500,
          timeoutError: () => new ActionableError("timed out"),
        }),
      );
      await Promise.resolve();
      timer.advanceTime(500);
      await expect(pending).rejects.toThrow("timed out");
      expect(fs.removed).toContain("/cache/asset.download");
    });

    test("no timeout means no abort signal and the original download error propagates", async () => {
      downloader.failure = new Error("network down");
      await expect(cache.fetch(request())).rejects.toThrow("network down");
      expect(downloader.calls[0].signal).toBeUndefined();
    });

    test("cleanup failure is logged and does not replace the original error", async () => {
      checksum.checksum = "c".repeat(64);
      fs.failRemove = true;
      await expect(cache.fetch(request())).rejects.toThrow(/mismatch/);
    });
  });
});
