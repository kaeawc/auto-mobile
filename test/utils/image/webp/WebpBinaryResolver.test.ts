import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { FileDownloader } from "../../../../src/utils/FileDownloader";
import { WebpBinaryResolver } from "../../../../src/utils/image/webp/WebpBinaryResolver";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import { FakeChecksumCalculator } from "../../../fakes/FakeChecksumCalculator";
import { FakeChildProcess } from "../../../fakes/FakeChildProcess";
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

  test("a failed provision is not cached — the .finally clears the in-flight map so a retry re-downloads (#3623)", async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, "cache");
    const downloader = new CountingFileDownloader();
    const processExecutor = new FakeProcessExecutor();
    // A mismatching checksum makes every provisionArchive attempt throw.
    const checksumCalculator = fakeArchiveChecksumCalculator("0".repeat(64));

    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      cacheDir,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
      fileDownloader: downloader,
      processExecutor,
      checksumCalculator,
    });

    await resolver.resolveCwebp().catch(() => undefined);
    await resolver.resolveCwebp().catch(() => undefined);

    // If provisionArchiveOnce's .finally didn't run after the rejection, the second
    // attempt would await the cached rejected promise and skip the download. Two
    // downloads proves the failed entry was cleared (removing the no-op .catch left
    // that cleanup intact).
    expect(downloader.downloadedUrls).toHaveLength(2);
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

/**
 * Drive a FakeChildProcess once the codec has written stdin and attached its
 * listeners. Keying off `stdin` finish makes ordering deterministic regardless
 * of how long the real filesystem resolution ahead of the spawn takes. Data is
 * pushed synchronously; `close` fires on a later macrotask so the readable
 * `data` events flush first.
 */
function driveChild(
  child: FakeChildProcess,
  { stdout = Buffer.alloc(0), stderr = "", exitCode = 0 }: { stdout?: Buffer; stderr?: string; exitCode?: number } = {}
): void {
  child.stdin.on("finish", () => {
    if (stdout.length > 0) {
      child.stdout.push(stdout);
    }
    child.stdout.push(null);
    if (stderr) {
      child.stderr.push(Buffer.from(stderr));
    }
    child.stderr.push(null);
    defaultTimer.setTimeout(() => {
      child.exitCode = exitCode;
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    }, 0);
  });
}

async function resolverWithExecutable(
  binary: "cwebp" | "dwebp",
  processExecutor: FakeProcessExecutor
): Promise<WebpBinaryResolver> {
  const root = await makeTempDir();
  const binaryPath = path.join(root, "bin", binary);
  await writeExecutable(binaryPath);
  const envVar = binary === "cwebp" ? "AUTOMOBILE_CWEBP_PATH" : "AUTOMOBILE_DWEBP_PATH";
  return new WebpBinaryResolver({
    projectRoot: root,
    platform: "darwin",
    arch: "arm64",
    env: { [envVar]: binaryPath, PATH: "" },
    processExecutor
  });
}

describe("WebpBinaryResolver codec execution", () => {
  test("resolves cwebp then spawns it with structural argv over stdin/stdout", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    driveChild(child, { stdout: Buffer.from("RIFFxxxxWEBPencoded") });
    processExecutor.setNextSpawnProcess(child);
    const resolver = await resolverWithExecutable("cwebp", processExecutor);
    const input = Buffer.from("png-data");

    const output = await resolver.runCwebp(["-q", "60", "-o", "-", "--", "-"], input);

    expect(output.toString()).toBe("RIFFxxxxWEBPencoded");
    expect(child.getStdinData()).toEqual(input);
    const spawned = processExecutor.getSpawnedProcesses();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(["-q", "60", "-o", "-", "--", "-"]);
    expect(spawned[0].command).toContain("cwebp");
  });

  test("runDwebp spawns the resolved dwebp binary", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    driveChild(child, { stdout: Buffer.from("png-output") });
    processExecutor.setNextSpawnProcess(child);
    const resolver = await resolverWithExecutable("dwebp", processExecutor);

    const output = await resolver.runDwebp(["-o", "-", "--", "-"], Buffer.from("RIFFxxxxWEBPdata"));

    expect(output.toString()).toBe("png-output");
    expect(processExecutor.getSpawnedProcesses()[0].command).toContain("dwebp");
  });

  test("surfaces non-zero exit with stderr detail as an actionable error", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    driveChild(child, { stderr: "bad webp", exitCode: 1 });
    processExecutor.setNextSpawnProcess(child);
    const resolver = await resolverWithExecutable("cwebp", processExecutor);

    const thrown = await resolver.runCwebp(["-o", "-", "--", "-"], Buffer.from("png")).catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("cwebp");
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("bad webp");
  });

  test("surfaces stdin write failures as actionable errors", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    child.setStdinError("write EPIPE");
    processExecutor.setNextSpawnProcess(child);
    const resolver = await resolverWithExecutable("cwebp", processExecutor);

    const thrown = await resolver.runCwebp(["-o", "-", "--", "-"], Buffer.from("png")).catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("cwebp");
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("write EPIPE");
  });

  test("propagates missing-binary resolution failures before spawning", async () => {
    const root = await makeTempDir();
    const processExecutor = new FakeProcessExecutor();
    const resolver = new WebpBinaryResolver({
      projectRoot: root,
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
      processExecutor
    });

    const thrown = await resolver.runCwebp(["-o", "-", "--", "-"], Buffer.from("png")).catch(error => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(processExecutor.getSpawnedProcesses()).toEqual([]);
  });
});
