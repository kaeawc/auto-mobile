import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { FileDownloader } from "../../../../src/utils/FileDownloader";
import { WebpBinaryResolver } from "../../../../src/utils/image/webp/WebpBinaryResolver";
import { FakeFileDownloader } from "../../../fakes/FakeFileDownloader";
import { FakeProcessExecutor } from "../../../fakes/FakeProcessExecutor";

const tempDirs: string[] = [];

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

class CountingFileDownloader implements FileDownloader {
  readonly downloadedUrls: string[] = [];

  async download(url: string, destination: string): Promise<void> {
    this.downloadedUrls.push(url);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "fake archive");
  }
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
      processExecutor
    });

    const resolved = await resolver.resolveCwebp();

    expect(resolved).toBe(path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"));
    expect(downloader.downloadedUrls).toEqual([
      "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-mac-arm64.tar.gz"
    ]);
    expect(processExecutor.wasCommandExecuted("tar -xzf")).toBe(true);
  });

  test("provisions the shared off-platform archive once when resolving both binaries", async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, "cache");
    const downloader = new CountingFileDownloader();
    const processExecutor = new FakeProcessExecutor();
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
      processExecutor
    });

    const resolved = await resolver.resolve();

    expect(resolved).toEqual({
      cwebp: path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "cwebp"),
      dwebp: path.join(cacheDir, "libwebp-1.6.0-mac-arm64", "bin", "dwebp")
    });
    expect(downloader.downloadedUrls).toHaveLength(1);
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
