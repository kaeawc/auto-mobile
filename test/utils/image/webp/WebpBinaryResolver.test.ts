import { describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { FileDownloader } from "../../../../src/utils/FileDownloader";
import {
  defaultWebpBinaryFileSystem,
  WebpBinaryResolver,
  type WebpBinaryResolverOptions,
} from "../../../../src/utils/image/webp/WebpBinaryResolver";
import { FakeArchiveExtractor } from "../../../fakes/FakeArchiveExtractor";
import { FakeChecksumCalculator } from "../../../fakes/FakeChecksumCalculator";
import { FakeChildProcess } from "../../../fakes/FakeChildProcess";
import { FakeProcessExecutor } from "../../../fakes/FakeProcessExecutor";
import { FakeWebpBinaryFileSystem } from "../../../fakes/FakeWebpBinaryFileSystem";

const hostSupportsPosixExecuteBits = process.platform !== "win32";
const MAC_ARM64_ARCHIVE_SHA256 = "bc6bf84cc70f3f8574fba797d1e4a7dea4feebe9fa4be919f202413ea2b3b8f2";
const ROOT = path.join(path.sep, "virtual", "webp-root");
const CACHE_DIR = path.join(ROOT, "cache");
const MAC_ARM64_ARCHIVE = path.join(CACHE_DIR, "libwebp-1.6.0-mac-arm64.tar.gz");
const MAC_ARM64_CWEBP = path.join(CACHE_DIR, "libwebp-1.6.0-mac-arm64", "bin", "cwebp");
const MAC_ARM64_DWEBP = path.join(CACHE_DIR, "libwebp-1.6.0-mac-arm64", "bin", "dwebp");

/** Records downloads without touching the disk; optionally blocks on a gate. */
class CountingFileDownloader implements FileDownloader {
  readonly downloadedUrls: string[] = [];
  readonly entered = Promise.withResolvers<void>();
  gate?: Promise<void>;

  async download(url: string): Promise<void> {
    this.downloadedUrls.push(url);
    this.entered.resolve();
    await this.gate;
  }
}

function fakeArchiveChecksumCalculator(
  checksum = MAC_ARM64_ARCHIVE_SHA256,
): FakeChecksumCalculator {
  const checksumCalculator = new FakeChecksumCalculator();
  checksumCalculator.checksum = checksum;
  return checksumCalculator;
}

function resolverFor(
  fileSystem: FakeWebpBinaryFileSystem,
  options: WebpBinaryResolverOptions = {},
): WebpBinaryResolver {
  return new WebpBinaryResolver({ projectRoot: ROOT, fileSystem, ...options });
}

function macArm64Options(
  fileSystem: FakeWebpBinaryFileSystem,
  extractedBinaries: string[],
  checksum?: string,
) {
  const archiveExtractor = new FakeArchiveExtractor();
  archiveExtractor.onExtract = () => {
    for (const binary of extractedBinaries) {
      fileSystem.addExecutable(binary);
    }
  };
  return {
    cacheDir: CACHE_DIR,
    platform: "darwin" as const,
    arch: "arm64" as const,
    env: { PATH: "" },
    archiveExtractor,
    checksumCalculator: fakeArchiveChecksumCalculator(checksum),
  };
}

describe("WebpBinaryResolver", () => {
  test("prefers cwebp and dwebp environment overrides", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const cwebp = path.join(ROOT, "override", "cwebp.exe");
    const dwebp = path.join(ROOT, "override", "dwebp.exe");
    fileSystem.addExecutable(cwebp);
    fileSystem.addExecutable(dwebp);

    const resolver = resolverFor(fileSystem, {
      platform: "win32",
      arch: "x64",
      env: { AUTOMOBILE_CWEBP_PATH: cwebp, AUTOMOBILE_DWEBP_PATH: dwebp, PATH: "" },
    });

    await expect(resolver.resolveCwebp()).resolves.toBe(cwebp);
    await expect(resolver.resolveDwebp()).resolves.toBe(dwebp);
  });

  test("uses PATH before the bundled Windows copy", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const pathDir = path.join(ROOT, "path-bin");
    const pathCwebp = path.join(pathDir, "cwebp.exe");
    fileSystem.addExecutable(pathCwebp);
    fileSystem.addExecutable(path.join(ROOT, "vendor", "libwebp", "win32-x64", "cwebp.exe"));

    const resolver = resolverFor(fileSystem, {
      platform: "win32",
      arch: "x64",
      env: { PATH: pathDir },
    });

    await expect(resolver.resolveCwebp()).resolves.toBe(pathCwebp);
  });

  test("uses the bundled x64 copy on Windows ARM64 via emulation", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const bundledCwebp = path.join(ROOT, "vendor", "libwebp", "win32-x64", "cwebp.exe");
    fileSystem.addExecutable(bundledCwebp);

    const resolver = resolverFor(fileSystem, {
      platform: "win32",
      arch: "arm64",
      env: { PATH: "" },
    });

    await expect(resolver.resolveCwebp()).resolves.toBe(bundledCwebp);
  });

  test("does not use the bundled Windows copy on unsupported Windows architectures", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    fileSystem.addExecutable(path.join(ROOT, "vendor", "libwebp", "win32-x64", "cwebp.exe"));

    const resolver = resolverFor(fileSystem, {
      platform: "win32",
      arch: "ia32",
      env: { PATH: "" },
    });

    await expect(resolver.resolveCwebp()).rejects.toBeInstanceOf(ActionableError);
  });

  test("skips non-executable PATH candidates", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const executableCwebp = path.join(ROOT, "second-bin", "cwebp");
    fileSystem.addExecutable(executableCwebp);

    const resolver = resolverFor(fileSystem, {
      platform: "darwin",
      arch: "arm64",
      env: { PATH: `${path.join(ROOT, "first-bin")}:${path.join(ROOT, "second-bin")}` },
    });

    await expect(resolver.resolveCwebp()).resolves.toBe(executableCwebp);
  });

  test("rejects non-executable environment overrides", async () => {
    const resolver = resolverFor(new FakeWebpBinaryFileSystem(), {
      platform: "darwin",
      arch: "arm64",
      env: { AUTOMOBILE_CWEBP_PATH: path.join(ROOT, "override", "cwebp"), PATH: "" },
    });

    const thrown = await resolver.resolveCwebp().catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("not executable");
  });

  test("falls back to the bundled Windows copy", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const bundledDwebp = path.join(ROOT, "vendor", "libwebp", "win32-x64", "dwebp.exe");
    fileSystem.addExecutable(bundledDwebp);

    const resolver = resolverFor(fileSystem, {
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
    });

    await expect(resolver.resolveDwebp()).resolves.toBe(bundledDwebp);
  });

  test("downloads and extracts off-platform binaries on demand", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const downloader = new CountingFileDownloader();
    const options = macArm64Options(fileSystem, [MAC_ARM64_CWEBP]);

    const resolver = resolverFor(fileSystem, { ...options, fileDownloader: downloader });

    const resolved = await resolver.resolveCwebp();

    expect(resolved).toBe(MAC_ARM64_CWEBP);
    expect(downloader.downloadedUrls).toEqual([
      "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-mac-arm64.tar.gz",
    ]);
    expect(options.checksumCalculator.computedFiles).toEqual([MAC_ARM64_ARCHIVE]);
    expect(fileSystem.ensuredDirectories).toEqual([CACHE_DIR]);
    expect(options.archiveExtractor.requests).toHaveLength(1);
    expect(options.archiveExtractor.requests[0]).toMatchObject({
      archivePath: MAC_ARM64_ARCHIVE,
      destinationDir: CACHE_DIR,
    });
  });

  test("rejects downloaded archives with mismatched SHA-256 before extraction", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const options = macArm64Options(fileSystem, [], "0".repeat(64));

    const resolver = resolverFor(fileSystem, {
      ...options,
      fileDownloader: new CountingFileDownloader(),
    });

    const thrown = await resolver.resolveCwebp().catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("checksum verification failed");
    expect(options.checksumCalculator.computedFiles).toEqual([MAC_ARM64_ARCHIVE]);
    expect(options.archiveExtractor.requests).toHaveLength(0);
  });

  test("a failed provision is not cached — the .finally clears the in-flight map so a retry re-downloads (#3623)", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const downloader = new CountingFileDownloader();
    // A mismatching checksum makes every provisionArchive attempt throw.
    const options = macArm64Options(fileSystem, [], "0".repeat(64));

    const resolver = resolverFor(fileSystem, { ...options, fileDownloader: downloader });

    await resolver.resolveCwebp().catch(() => undefined);
    await resolver.resolveCwebp().catch(() => undefined);

    // If provisionArchiveOnce's .finally didn't run after the rejection, the second
    // attempt would await the cached rejected promise and skip the download. Two
    // downloads proves the failed entry was cleared (removing the no-op .catch left
    // that cleanup intact).
    expect(downloader.downloadedUrls).toHaveLength(2);
  });

  test("provisions the shared off-platform archive once when resolving both binaries", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const downloader = new CountingFileDownloader();
    const options = macArm64Options(fileSystem, [MAC_ARM64_CWEBP, MAC_ARM64_DWEBP]);

    const resolver = resolverFor(fileSystem, { ...options, fileDownloader: downloader });

    const resolved = await resolver.resolve();

    expect(resolved).toEqual({ cwebp: MAC_ARM64_CWEBP, dwebp: MAC_ARM64_DWEBP });
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(options.checksumCalculator.computedFiles).toEqual([MAC_ARM64_ARCHIVE]);
    expect(options.archiveExtractor.requests).toHaveLength(1);
  });

  test("shares off-platform archive provisioning across resolver instances", async () => {
    const fileSystem = new FakeWebpBinaryFileSystem();
    const downloader = new CountingFileDownloader();
    const downloadGate = Promise.withResolvers<void>();
    downloader.gate = downloadGate.promise;
    const options = macArm64Options(fileSystem, [MAC_ARM64_CWEBP]);

    const resolverOptions = { ...options, fileDownloader: downloader };
    const firstResolver = resolverFor(fileSystem, resolverOptions);
    const secondResolver = resolverFor(fileSystem, resolverOptions);
    // Observe the second caller entering the shared in-flight map, rather than
    // assuming its probes finish before a fixed download delay.
    const secondProvisionStarted = Promise.withResolvers<void>();
    const secondProvisioner = secondResolver as unknown as {
      provisionArchiveOnce(archive: unknown): Promise<void>;
    };
    const provisionArchiveOnce = secondProvisioner.provisionArchiveOnce.bind(secondResolver);
    const provisionSpy = spyOn(secondProvisioner, "provisionArchiveOnce").mockImplementation(
      (archive) => {
        const provision = provisionArchiveOnce(archive);
        secondProvisionStarted.resolve();
        return provision;
      },
    );
    let first: string;
    let second: string;
    try {
      const firstResolution = firstResolver.resolveCwebp();
      await downloader.entered.promise;
      const secondResolution = secondResolver.resolveCwebp();
      await secondProvisionStarted.promise;
      expect(downloader.downloadedUrls).toHaveLength(1);
      downloadGate.resolve();
      [first, second] = await Promise.all([firstResolution, secondResolution]);
    } finally {
      downloadGate.resolve();
      provisionSpy.mockRestore();
    }

    expect(first).toBe(MAC_ARM64_CWEBP);
    expect(second).toBe(first);
    expect(downloader.downloadedUrls).toHaveLength(1);
    expect(options.checksumCalculator.computedFiles).toEqual([MAC_ARM64_ARCHIVE]);
    expect(options.archiveExtractor.requests).toHaveLength(1);
  });

  test("throws an actionable error when no binary can be resolved", async () => {
    const resolver = resolverFor(new FakeWebpBinaryFileSystem(), {
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
    });

    const thrown = await resolver.resolveCwebp().catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("cwebp");
  });
});

describe("defaultWebpBinaryFileSystem", () => {
  test("treats a missing path as not executable without throwing", async () => {
    const missing = path.join(ROOT, "definitely", "missing", "cwebp");

    await expect(defaultWebpBinaryFileSystem.isExecutableFile(missing, "darwin")).resolves.toBe(
      false,
    );
  });

  test.skipIf(!hostSupportsPosixExecuteBits)(
    "accepts an executable file and rejects a directory on POSIX hosts",
    async () => {
      // process.execPath is a real executable file on every host; its parent is a directory.
      await expect(
        defaultWebpBinaryFileSystem.isExecutableFile(process.execPath, "darwin"),
      ).resolves.toBe(true);
      await expect(
        defaultWebpBinaryFileSystem.isExecutableFile(path.dirname(process.execPath), "darwin"),
      ).resolves.toBe(false);
    },
  );

  test.skipIf(!hostSupportsPosixExecuteBits)(
    "rejects a non-executable regular file on POSIX hosts",
    async () => {
      // package.json is a checked-in regular file (mode 0644), never executable.
      const nonExecutable = path.join(import.meta.dir, "../../../../package.json");

      await expect(
        defaultWebpBinaryFileSystem.isExecutableFile(nonExecutable, "darwin"),
      ).resolves.toBe(false);
    },
  );
});

/**
 * Drive a FakeChildProcess once the codec has written stdin and attached its
 * listeners. Keying off `stdin` finish makes ordering deterministic. Output is
 * pushed synchronously and `close` is emitted only after both readable streams
 * have ended, so no timer is involved and every `data` event is guaranteed to
 * have flushed before the exit is observed.
 */
function driveChild(
  child: FakeChildProcess,
  {
    stdout = Buffer.alloc(0),
    stderr = "",
    exitCode = 0,
  }: { stdout?: Buffer; stderr?: string; exitCode?: number } = {},
): void {
  const drained = Promise.all([
    new Promise<void>((resolve) => child.stdout.once("end", resolve)),
    new Promise<void>((resolve) => child.stderr.once("end", resolve)),
  ]);
  child.stdin.on("finish", () => {
    if (stdout.length > 0) {
      child.stdout.push(stdout);
    }
    child.stdout.push(null);
    if (stderr) {
      child.stderr.push(Buffer.from(stderr));
    }
    child.stderr.push(null);
  });
  void drained.then(() => {
    child.exitCode = exitCode;
    child.emit("exit", exitCode, null);
    child.emit("close", exitCode, null);
  });
}

function resolverWithExecutable(
  binary: "cwebp" | "dwebp",
  processExecutor: FakeProcessExecutor,
): WebpBinaryResolver {
  const fileSystem = new FakeWebpBinaryFileSystem();
  const binaryPath = path.join(ROOT, "bin", binary);
  fileSystem.addExecutable(binaryPath);
  const envVar = binary === "cwebp" ? "AUTOMOBILE_CWEBP_PATH" : "AUTOMOBILE_DWEBP_PATH";
  return resolverFor(fileSystem, {
    platform: "darwin",
    arch: "arm64",
    env: { [envVar]: binaryPath, PATH: "" },
    processExecutor,
  });
}

describe("WebpBinaryResolver codec execution", () => {
  test("resolves cwebp then spawns it with structural argv over stdin/stdout", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    driveChild(child, { stdout: Buffer.from("RIFFxxxxWEBPencoded") });
    processExecutor.setNextSpawnProcess(child);
    const resolver = resolverWithExecutable("cwebp", processExecutor);
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
    const resolver = resolverWithExecutable("dwebp", processExecutor);

    const output = await resolver.runDwebp(["-o", "-", "--", "-"], Buffer.from("RIFFxxxxWEBPdata"));

    expect(output.toString()).toBe("png-output");
    expect(processExecutor.getSpawnedProcesses()[0].command).toContain("dwebp");
  });

  test("surfaces non-zero exit with stderr detail as an actionable error", async () => {
    const processExecutor = new FakeProcessExecutor();
    const child = new FakeChildProcess();
    driveChild(child, { stderr: "bad webp", exitCode: 1 });
    processExecutor.setNextSpawnProcess(child);
    const resolver = resolverWithExecutable("cwebp", processExecutor);

    const thrown = await resolver
      .runCwebp(["-o", "-", "--", "-"], Buffer.from("png"))
      .catch((error) => error);

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
    const resolver = resolverWithExecutable("cwebp", processExecutor);

    const thrown = await resolver
      .runCwebp(["-o", "-", "--", "-"], Buffer.from("png"))
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("cwebp");
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(thrown.message).toContain("write EPIPE");
  });

  test("propagates missing-binary resolution failures before spawning", async () => {
    const processExecutor = new FakeProcessExecutor();
    const resolver = resolverFor(new FakeWebpBinaryFileSystem(), {
      platform: "win32",
      arch: "x64",
      env: { PATH: "" },
      processExecutor,
    });

    const thrown = await resolver
      .runCwebp(["-o", "-", "--", "-"], Buffer.from("png"))
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(thrown.message).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(processExecutor.getSpawnedProcesses()).toEqual([]);
  });
});
