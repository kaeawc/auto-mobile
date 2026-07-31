import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  VIDEO_SERVER_JAR_CACHE_FILENAME,
  VIDEO_SERVER_JAR_METADATA_FILENAME,
  VideoServerJarProvider,
  type VideoServerJarMetadata,
} from "../../../src/features/webrtc/VideoServerJarProvider";
import { FakeChecksumCalculator } from "../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../fakes/FakeFileDownloader";
import { FakeTimer } from "../../fakes/FakeTimer";

const EXPECTED_SHA = "a".repeat(64);

/** A minimal valid jar: a zip containing a `classes.dex` entry. */
function validJarBuffer(): Buffer {
  const zip = new AdmZip();
  zip.addFile("classes.dex", Buffer.from("dex-bytes"));
  return zip.toBuffer();
}

/** A zip without `classes.dex` — passes checksum but fails the structural check. */
function zipWithoutDexBuffer(): Buffer {
  const zip = new AdmZip();
  zip.addFile("other.txt", Buffer.from("nope"));
  return zip.toBuffer();
}

describe("VideoServerJarProvider (#3831)", function() {
  let cacheDir: string;
  let downloader: FakeFileDownloader;
  let checksum: FakeChecksumCalculator;
  let timer: FakeTimer;

  function makeProvider(): VideoServerJarProvider {
    return new VideoServerJarProvider({
      downloader,
      checksumCalculator: checksum,
      cacheDir,
      timer,
      // Pin so resolveVideoJarUrl produces a concrete URL; the fake downloader
      // ignores it anyway. Checksum is forced via setExpectedChecksumForTesting.
      env: { AUTOMOBILE_VERSION: "latest" },
    });
  }

  beforeEach(async function() {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-jar-test-"));
    downloader = new FakeFileDownloader();
    downloader.payload = validJarBuffer();
    checksum = new FakeChecksumCalculator();
    checksum.checksum = EXPECTED_SHA;
    timer = new FakeTimer();
    timer.setCurrentTime(1000);
    VideoServerJarProvider.resetInstances();
    VideoServerJarProvider.setExpectedChecksumForTesting(EXPECTED_SHA);
  });

  afterEach(async function() {
    VideoServerJarProvider.resetInstances();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  test("downloads, verifies, and caches the jar with a metadata sidecar", async function() {
    const provider = makeProvider();
    const jarPath = await provider.ensure();

    expect(jarPath).toBe(path.join(cacheDir, VIDEO_SERVER_JAR_CACHE_FILENAME));
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(downloader.downloadedUrls[0]).toContain(VIDEO_SERVER_JAR_CACHE_FILENAME);

    // Cached file is present and is the verified jar.
    const stats = await fs.stat(jarPath!);
    expect(stats.isFile()).toBe(true);

    // Metadata sidecar records version, sha, and (fake) timestamp.
    const meta = JSON.parse(
      await fs.readFile(path.join(cacheDir, VIDEO_SERVER_JAR_METADATA_FILENAME), "utf8")
    ) as VideoServerJarMetadata;
    expect(meta.sha256).toBe(EXPECTED_SHA);
    expect(meta.version).toBe("latest");
    expect(meta.downloadedAt).toBe(1000);
    expect(meta.size).toBe(stats.size);
  });

  test("computeLocalJarIntegrity returns the lowercased sha256 and byte size of a local jar (#4733)", async function() {
    // A real on-disk jar so the fs.stat size is genuine; the sha comes from the
    // injected canonical calculator (here forced to a known value).
    const localJar = path.join(cacheDir, "override-automobile-video.jar");
    const bytes = validJarBuffer();
    await fs.writeFile(localJar, bytes);
    checksum.setFileChecksum(localJar, "A".repeat(64)); // upper-case in => lower-case out

    const integrity = await makeProvider().computeLocalJarIntegrity(localJar);

    expect(integrity.sha256).toBe("a".repeat(64));
    expect(integrity.size).toBe(bytes.length);
    expect(checksum.computedFiles).toContain(localJar);
  });

  test("invalidates the cache and re-downloads when the on-disk jar size no longer matches the sidecar", async function() {
    const jarPath = (await makeProvider().ensure())!;
    expect(downloader.downloadedUrls).toHaveLength(1);

    // Simulate out-of-band truncation of the cached jar.
    await fs.writeFile(jarPath, Buffer.from("truncated"));

    const reFetched = await makeProvider().ensure();
    expect(reFetched).toBe(jarPath);
    expect(downloader.downloadedUrls).toHaveLength(2);
  });

  test("reuses a valid cache without re-downloading", async function() {
    await makeProvider().ensure();
    expect(downloader.downloadedUrls).toHaveLength(1);

    // Second provider over the same cache dir must not hit the network again.
    const second = makeProvider();
    const jarPath = await second.ensure();
    expect(jarPath).toBe(path.join(cacheDir, VIDEO_SERVER_JAR_CACHE_FILENAME));
    expect(downloader.downloadedUrls).toHaveLength(1);
  });

  test("re-downloads when the cached sha no longer matches the expected sha", async function() {
    await makeProvider().ensure();

    // A new expected checksum (e.g. a version bump) invalidates the cache.
    const newSha = "b".repeat(64);
    VideoServerJarProvider.setExpectedChecksumForTesting(newSha);
    checksum.checksum = newSha;

    const jarPath = await makeProvider().ensure();
    expect(jarPath).not.toBeNull();
    expect(downloader.downloadedUrls).toHaveLength(2);
  });

  test("rejects a corrupt/truncated download (invalid zip, no classes.dex)", async function() {
    downloader.payload = Buffer.from("not-a-zip-file");
    await expect(makeProvider().ensure()).rejects.toThrow(/classes\.dex/);

    // Nothing is left cached.
    await expect(
      fs.access(path.join(cacheDir, VIDEO_SERVER_JAR_CACHE_FILENAME))
    ).rejects.toThrow();
  });

  test("rejects a zip that is valid but missing classes.dex", async function() {
    downloader.payload = zipWithoutDexBuffer();
    await expect(makeProvider().ensure()).rejects.toThrow(/classes\.dex/);
  });

  test("rejects a checksum mismatch and leaves no cached file", async function() {
    checksum.checksum = "c".repeat(64); // differs from the forced expected sha
    await expect(makeProvider().ensure()).rejects.toThrow(/checksum verification failed/);
    await expect(
      fs.access(path.join(cacheDir, VIDEO_SERVER_JAR_CACHE_FILENAME))
    ).rejects.toThrow();
  });

  test("returns null (degrade) when the expected checksum is unknown, without touching the network", async function() {
    VideoServerJarProvider.setExpectedChecksumForTesting("");
    const jarPath = await makeProvider().ensure();
    expect(jarPath).toBeNull();
    expect(downloader.downloadedUrls).toHaveLength(0);
  });

  test("single-flight: concurrent ensure() calls share one download", async function() {
    const provider = makeProvider();
    const [a, b] = await Promise.all([provider.ensure(), provider.ensure()]);
    expect(a).toBe(b!);
    expect(downloader.downloadedUrls).toHaveLength(1);
  });
});
