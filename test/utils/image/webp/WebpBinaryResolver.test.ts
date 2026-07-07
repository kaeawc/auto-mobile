import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { FileDownloader } from "../../../../src/utils/FileDownloader";
import { WebpBinaryResolver } from "../../../../src/utils/image/webp/WebpBinaryResolver";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import { FakeChecksumCalculator } from "../../../fakes/FakeChecksumCalculator";
import { FakeFileDownloader } from "../../../fakes/FakeFileDownloader";
import { FakeProcessExecutor } from "../../../fakes/FakeProcessExecutor";

const tempDirs: string[] = [];
const hostSupportsPosixExecuteBits = process.platform !== "win32";
const MAC_ARM64_ARCHIVE_SHA256 = "bc6bf84cc70f3f8574fba797d1e4a7dea4feebe9fa4be919f202413ea2b3b8f2";

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-webp-resolver-"));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "fake");
  await fs.chmod(filePath, 0o755);
}

async function writeNonExecutable(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "fake");
  await fs.chmod(filePath, 0o644);
}

class CountingFileDownloader implements FileDownloader {
  readonly downloadedUrls: string[] = [];
  delayMs = 0;

  async download(url: string, destination: string): Promise<void> {
    this.downloadedUrls.push(url);
    if (this.delayMs > 0) {
      await new Promise(resolve => defaultTimer.setTimeout(resolve, this.delayMs));
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "fake archive");
  }
}

function fakeArchiveChecksumCalculator(checksum = MAC_ARM64_ARCHIVE_SHA256): FakeChecksumCalculator {
  const checksumCalculator = new FakeChecksumCalculator();
  checksumCalculator.checksum = checksum;
  return checksumCalculator;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("WebpBinaryResolver", () => {
  test("prefers cwebp and dwebp environment overrides", async () => {
    const root = await makeTempDir();
    const cwebp = path.join(root, "override", "cwebp.exe");
    const dwebp = path.join(root, "override", "dwebp.exe");
    await writeExecutable(cwebp);
    await writeExecutable(dwebp);

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      platform: "win32",
      arch: "x64",
      env: {
        AUTOMOBILE_CWEBP_PATH: cwebp,
        AUTOMOBILE_DWEBP_PATH: dwebp,
        PATH: ""
      }
    });

    await expect(resolver.resolveCwebp()).resolves.toBe(cwebp);
    await expect(resolver.resolveDwebp()).resolves.toBe(dwebp);
  });

  test("uses PATH before the bundled Windows copy", async () => {
    const root = await makeTempDir();
    const pathDir = path.join(root, "path-bin");
    const pathCwebp = path.join(pathDir, "cwebp.exe");
    const bundledCwebp = path.join(root, "vendor", "libwebp", "win32-x64", "cwebp.exe");
    await writeExecutable(pathCwebp);
    await writeExecutable(bundledCwebp);

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      platform: "win32",
      arch: "x64",
      env: { PATH: pathDir }
    });

    await expect(resolver.resolveCwebp()).resolves.toBe(pathCwebp);
  });

  test.skipIf(!hostSupportsPosixExecuteBits)("skips non-executable PATH candidates on POSIX platforms", async () => {
    const root = await makeTempDir();
    const firstPathDir = path.join(root, "first-bin");
    const secondPathDir = path.join(root, "second-bin");
    const nonExecutableCwebp = path.join(firstPathDir, "cwebp");
    const executableCwebp = path.join(secondPathDir, "cwebp");
    await writeNonExecutable(nonExecutableCwebp);
    await writeExecutable(executableCwebp);

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: `${firstPathDir}:${secondPathDir}` }
    });

    await expect(resolver.resolveCwebp()).resolves.toBe(executableCwebp);
  });

  test.skipIf(!hostSupportsPosixExecuteBits)("rejects non-executable environment overrides on POSIX platforms", async () => {
    const root = await makeTempDir();
    const cwebp = path.join(root, "override", "cwebp");
    await writeNonExecutable(cwebp);

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      platform: "darwin",
      arch: "arm64",
      env: {
        AUTOMOBILE_CWEBP_PATH: cwebp,
        PATH: ""
      }
    });

    const thrown = await resolver.resolveCwebp().catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("not executable");
  });

  test("falls back to the bundled Windows copy", async () => {
    const root = await makeTempDir();
    const bundledDwebp = path.join(root, "vendor", "libwebp", "win32-x64", "dwebp.exe");
    await writeExecutable(bundledDwebp);

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" }
    });

    await expect(resolver.resolveDwebp()).resolves.toBe(bundledDwebp);
  });

  test("downloads and extracts off-platform binaries on demand", async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, "cache");
    const downloader = new FakeFileDownloader();
    const processExecutor = new FakeProcessExecutor();
    const checksumCalculator = fakeArchiveChecksumCalculator();
    processExecutor.setCommandHandler("tar -xzf", async () => {
      await writeExecutable(path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"));
      return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
    });

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      cacheDir,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
      fileDownloader: downloader,
      processExecutor,
      checksumCalculator
    });

    const resolved = await resolver.resolveCwebp();

    expect(resolved).toBe(path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"));
    expect(downloader.downloadedUrls).toEqual([
      "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-mac-arm64.tar.gz"
    ]);
    expect(checksumCalculator.computedFiles).toEqual([path.join(cacheDir, "libwebp-1.6.0-mac-arm64.tar.gz")]);
    expect(processExecutor.wasCommandExecuted("tar -xzf")).toBe(true);
  });

  test("rejects downloaded archives with mismatched SHA-256 before extraction", async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, "cache");
    const downloader = new FakeFileDownloader();
    const processExecutor = new FakeProcessExecutor();
    const checksumCalculator = fakeArchiveChecksumCalculator("0".repeat(64));

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      cacheDir,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
      fileDownloader: downloader,
      processExecutor,
      checksumCalculator
    });

    const thrown = await resolver.resolveCwebp().catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("checksum verification failed");
    expect(checksumCalculator.computedFiles).toEqual([path.join(cacheDir, "libwebp-1.6.0-mac-arm64.tar.gz")]);
    expect(processExecutor.wasCommandExecuted("tar -xzf")).toBe(false);
  });

  test("provisions the shared off-platform archive once when resolving both binaries", async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, "cache");
    const downloader = new CountingFileDownloader();
    const processExecutor = new FakeProcessExecutor();
    const checksumCalculator = fakeArchiveChecksumCalculator();
    let extractionCount = 0;
    processExecutor.setCommandHandler("tar -xzf", async () => {
      extractionCount += 1;
      await writeExecutable(path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"));
      await writeExecutable(path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "dwebp"));
      return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
    });

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      cacheDir,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
      fileDownloader: downloader,
      processExecutor,
      checksumCalculator
    });

    const resolved = await resolver.resolve();

    expect(resolved).toEqual({
      cwebp: path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"),
      dwebp: path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "dwebp")
    });
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(checksumCalculator.computedFiles).toEqual([path.join(cacheDir, "libwebp-1.6.0-mac-arm64.tar.gz")]);
    expect(extractionCount).toBe(1);
  });

  test("shares off-platform archive provisioning across resolver instances", async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, "cache");
    const downloader = new CountingFileDownloader();
    downloader.delayMs = 1;
    const processExecutor = new FakeProcessExecutor();
    const checksumCalculator = fakeArchiveChecksumCalculator();
    let extractionCount = 0;
    processExecutor.setCommandHandler("tar -xzf", async () => {
      extractionCount += 1;
      await writeExecutable(path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"));
      return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
    });

    const resolverOptions = {
      projectRoot: root,
      cacheDir,
      platform: "darwin" as const,
      arch: "arm64" as const,
      env: { PATH: "" },
      fileDownloader: downloader,
      processExecutor,
      checksumCalculator
    };

    const [first, second] = await Promise.all([
      new WebpBinaryResolver(resolverOptions).resolveCwebp(),
      new WebpBinaryResolver(resolverOptions).resolveCwebp()
    ]);

    expect(first).toBe(path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"));
    expect(second).toBe(first);
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(checksumCalculator.computedFiles).toEqual([path.join(cacheDir, "libwebp-1.6.0-mac-arm64.tar.gz")]);
    expect(extractionCount).toBe(1);
  });

  test("throws an actionable error when no binary can be resolved", async () => {
    const root = await makeTempDir();
    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" }
    });

    const thrown = await resolver.resolveCwebp().catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("cwebp");
  });
});
