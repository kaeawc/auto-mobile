import { errorMessage } from "../../describeUnknownError";
import { constants as fsConstants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import { ActionableError } from "../../../models/ActionableError";
import { type ArchiveExtractor, DefaultArchiveExtractor } from "../../ArchiveExtractor";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../ChecksumCalculator";
import { DefaultFileDownloader, type FileDownloader } from "../../FileDownloader";
import { DefaultHostCommandExecutor, type HostProcessExecutor } from "../../HostCommandExecutor";
import { logger } from "../../logger";
import { resolveAutoMobileBaseDir } from "../../tempDir";
import { defaultTimer, type Timer } from "../../SystemTimer";
import { raceWithDeadline } from "../../raceWithDeadline";
import { AMBIENT_ENV, ENV, readEnvRaw } from "../../../config/env";

export const WEBP_CODEC_TIMEOUT_MS = 30_000;

const LIBWEBP_VERSION = "1.6.0";
const WEBP_DOWNLOAD_BASE_URL =
  "https://storage.googleapis.com/downloads.webmproject.org/releases/webp";
const archiveProvisioningByPath = new Map<string, Promise<void>>();

type WebpBinary = "cwebp" | "dwebp";

interface WebpArchiveInfo {
  archiveName: string;
  directoryName: string;
  sha256: string;
}

/**
 * Narrow filesystem seam for binary discovery and cache preparation, so tests
 * can resolve binaries without touching the real disk.
 */
export interface WebpBinaryFileSystem {
  isExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean>;
  ensureDirectory(dirPath: string): Promise<void>;
  makeExecutable(filePath: string): Promise<void>;
}

export const defaultWebpBinaryFileSystem: WebpBinaryFileSystem = {
  isExecutableFile: (filePath, platform) => isExecutableFile(filePath, platform),
  ensureDirectory: async (dirPath) => {
    await fs.mkdir(dirPath, { recursive: true });
  },
  makeExecutable: async (filePath) => {
    await fs.chmod(filePath, 0o755).catch(() => undefined);
  },
};

export interface WebpBinaryResolverOptions {
  timer?: Timer;
  codecTimeoutMs?: number;
  fileSystem?: WebpBinaryFileSystem;
  projectRoot?: string;
  /** Explicit cache directory override; defaults to <data dir>/libwebp at use time. */
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  fileDownloader?: FileDownloader;
  archiveExtractor?: ArchiveExtractor;
  processExecutor?: HostProcessExecutor;
  checksumCalculator?: ChecksumCalculator;
  /** Observer invoked each time this resolver asks for an archive to be provisioned. */
  onArchiveProvisionRequested?: () => void;
}

export interface ResolvedWebpBinaries {
  cwebp: string;
  dwebp: string;
}

/**
 * The single injected boundary that both resolves and executes the libwebp
 * CLI tools. Consumers pass argv structurally (never shell-interpolated) and
 * receive the codec output buffer; the owner defines availability, process
 * lifecycle, child cleanup, and actionable errors. Keep image-transformation
 * semantics (argv construction, buffer sniffing) in the codec layer.
 */
export interface WebpBinaryProvider {
  resolveCwebp(): Promise<string>;
  resolveDwebp(): Promise<string>;
  runCwebp(args: string[], input: Buffer): Promise<Buffer>;
  runDwebp(args: string[], input: Buffer): Promise<Buffer>;
}

export class WebpBinaryResolver implements WebpBinaryProvider {
  private readonly timer: Timer | undefined;
  private readonly codecTimeoutMs: number | undefined;
  private readonly projectRoot: string;
  private readonly cacheDir: string | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fileDownloader: FileDownloader;
  private readonly archiveExtractor: ArchiveExtractor;
  private readonly processExecutor: HostProcessExecutor;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly fileSystem: WebpBinaryFileSystem;
  private readonly onArchiveProvisionRequested: (() => void) | undefined;

  constructor(options: WebpBinaryResolverOptions = {}) {
    this.timer = options.timer;
    this.codecTimeoutMs = options.codecTimeoutMs;
    this.projectRoot = options.projectRoot ?? defaultProjectRoot();
    this.cacheDir = options.cacheDir;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.fileDownloader = options.fileDownloader ?? new DefaultFileDownloader();
    this.archiveExtractor = options.archiveExtractor ?? new DefaultArchiveExtractor();
    this.processExecutor = options.processExecutor ?? new DefaultHostCommandExecutor();
    this.checksumCalculator = options.checksumCalculator ?? new DefaultChecksumCalculator();
    this.fileSystem = options.fileSystem ?? defaultWebpBinaryFileSystem;
    this.onArchiveProvisionRequested = options.onArchiveProvisionRequested;
  }

  async resolve(): Promise<ResolvedWebpBinaries> {
    const [cwebp, dwebp] = await Promise.all([this.resolveCwebp(), this.resolveDwebp()]);
    return { cwebp, dwebp };
  }

  async resolveCwebp(): Promise<string> {
    return this.resolveBinary("cwebp", ENV.CWEBP_PATH.name);
  }

  async resolveDwebp(): Promise<string> {
    return this.resolveBinary("dwebp", ENV.DWEBP_PATH.name);
  }

  async runCwebp(args: string[], input: Buffer): Promise<Buffer> {
    const command = await this.resolveCwebp();
    return this.runCodecProcess("cwebp", command, args, input, ENV.CWEBP_PATH.name);
  }

  async runDwebp(args: string[], input: Buffer): Promise<Buffer> {
    const command = await this.resolveDwebp();
    return this.runCodecProcess("dwebp", command, args, input, ENV.DWEBP_PATH.name);
  }

  private async runCodecProcess(
    toolName: WebpBinary,
    command: string,
    args: string[],
    input: Buffer,
    envVar: string,
  ): Promise<Buffer> {
    const child = this.processExecutor.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new ActionableError(
        `${toolName} was spawned without piped stdio. Set ${envVar} to a working ${toolName} binary.`,
      );
    }

    child.stdout.on("data", (data) =>
      stdout.push(Buffer.isBuffer(data) ? data : Buffer.from(data)),
    );
    child.stderr.on("data", (data) =>
      stderr.push(Buffer.isBuffer(data) ? data : Buffer.from(data)),
    );
    const codecTimeoutMs = this.codecTimeoutMs ?? WEBP_CODEC_TIMEOUT_MS;
    await raceWithDeadline(
      () => {
        const completion = waitForCompletion(child, child.stdin!, toolName, envVar, stderr);
        try {
          child.stdin!.end(input);
        } catch (error) {
          // The completion listeners remain responsible for late process events.
          void completion.catch(() => undefined);
          throw actionableProcessError(
            toolName,
            envVar,
            `stdin write failed: ${errorMessage(error)}`,
          );
        }
        return completion;
      },
      {
        timer: this.timer ?? defaultTimer,
        timeoutMs: codecTimeoutMs,
        label: toolName,
        timeoutError: () =>
          actionableProcessError(toolName, envVar, `timed out after ${codecTimeoutMs}ms`),
        onTimeout: () => {
          try {
            child.kill("SIGKILL");
          } catch (error) {
            // Signal delivery can race process exit; preserve the actionable deadline error.
            logger.debug(`${toolName} deadline SIGKILL failed: ${errorMessage(error)}`, error);
          }
        },
      },
    );
    return Buffer.concat(stdout);
  }

  private async resolveBinary(binary: WebpBinary, envVar: string): Promise<string> {
    const override = this.env[envVar]?.trim();
    if (override) {
      if (await this.fileSystem.isExecutableFile(override, this.platform)) {
        return override;
      }
      throw new ActionableError(
        `${envVar} points to '${override}', but that ${binary} binary is not executable or does not exist.`,
      );
    }

    const pathBinary = await this.findOnPath(binary);
    if (pathBinary) {
      return pathBinary;
    }

    const bundledBinary = await this.findBundledWindowsBinary(binary);
    if (bundledBinary) {
      return bundledBinary;
    }

    const downloadedBinary = await this.findOrDownloadOffPlatformBinary(binary);
    if (downloadedBinary) {
      return downloadedBinary;
    }

    throw new ActionableError(
      `Unable to resolve ${binary}. Set ${envVar}, add ${binary} to PATH, or ensure the bundled vendor/libwebp/win32-x64 copy is present.`,
    );
  }

  private async findOnPath(binary: WebpBinary): Promise<string | null> {
    const pathValue =
      readEnvRaw(AMBIENT_ENV.PATH, this.env) ??
      readEnvRaw(AMBIENT_ENV.WINDOWS_PATH, this.env) ??
      "";
    if (!pathValue) {
      return null;
    }

    for (const entry of pathValue.split(pathListDelimiter(this.platform))) {
      if (!entry) {
        continue;
      }
      for (const name of candidateBinaryNames(binary, this.platform)) {
        const candidate = path.join(entry, name);
        if (await this.fileSystem.isExecutableFile(candidate, this.platform)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private async findBundledWindowsBinary(binary: WebpBinary): Promise<string | null> {
    // Google publishes no native Windows ARM64 libwebp build. Windows on ARM
    // runs the bundled x64 tools through its built-in x64 emulation, so arm64
    // reuses the win32-x64 copy.
    if (this.platform !== "win32" || (this.arch !== "x64" && this.arch !== "arm64")) {
      return null;
    }

    const candidate = path.join(
      this.projectRoot,
      "vendor",
      "libwebp",
      "win32-x64",
      `${binary}.exe`,
    );
    return (await this.fileSystem.isExecutableFile(candidate, this.platform)) ? candidate : null;
  }

  private async findOrDownloadOffPlatformBinary(binary: WebpBinary): Promise<string | null> {
    const archive = archiveInfoFor(this.platform, this.arch);
    if (!archive) {
      return null;
    }

    const cacheDir = this.cacheDir ?? path.join(resolveAutoMobileBaseDir(this.env), "libwebp");
    const binaryPath = path.join(
      cacheDir,
      archive.directoryName,
      "bin",
      executableName(binary, this.platform),
    );
    if (await this.fileSystem.isExecutableFile(binaryPath, this.platform)) {
      return binaryPath;
    }

    await this.provisionArchiveOnce(archive, cacheDir);
    await this.fileSystem.makeExecutable(binaryPath);

    if (await this.fileSystem.isExecutableFile(binaryPath, this.platform)) {
      return binaryPath;
    }

    throw new ActionableError(
      `Downloaded libwebp archive did not provide ${binary} at ${binaryPath}. Set ${envVarFor(binary)} instead.`,
    );
  }

  private async provisionArchiveOnce(archive: WebpArchiveInfo, cacheDir: string): Promise<void> {
    this.onArchiveProvisionRequested?.();
    const archivePath = path.resolve(cacheDir, archive.archiveName);
    const existing = archiveProvisioningByPath.get(archivePath);
    if (existing) {
      await existing;
      return;
    }

    const provision = this.provisionArchive(archive, cacheDir).finally(() => {
      archiveProvisioningByPath.delete(archivePath);
    });
    archiveProvisioningByPath.set(archivePath, provision);
    await provision;
  }

  private async provisionArchive(archive: WebpArchiveInfo, cacheDir: string): Promise<void> {
    await this.fileSystem.ensureDirectory(cacheDir);
    const archivePath = path.join(cacheDir, archive.archiveName);
    await this.fileDownloader.download(
      `${WEBP_DOWNLOAD_BASE_URL}/${archive.archiveName}`,
      archivePath,
    );
    await this.verifyArchiveChecksum(archive, archivePath);
    await this.archiveExtractor.extractTarGz({ archivePath, destinationDir: cacheDir });
  }

  private async verifyArchiveChecksum(
    archive: WebpArchiveInfo,
    archivePath: string,
  ): Promise<void> {
    let actualChecksum: string;
    try {
      const result = await this.checksumCalculator.computeFileSha256(archivePath);
      actualChecksum = result.checksum.toLowerCase();
    } catch (error) {
      throw new ActionableError(
        `Unable to verify downloaded libwebp archive ${archive.archiveName}: ${errorMessage(error)}. ` +
          "Set AUTOMOBILE_CWEBP_PATH and AUTOMOBILE_DWEBP_PATH to trusted binaries, or retry the download.",
      );
    }

    const expectedChecksum = archive.sha256.toLowerCase();
    if (actualChecksum !== expectedChecksum) {
      throw new ActionableError(
        `Downloaded libwebp archive checksum verification failed for ${archive.archiveName}. ` +
          `Expected SHA-256 ${expectedChecksum}, got ${actualChecksum}. ` +
          "Set AUTOMOBILE_CWEBP_PATH and AUTOMOBILE_DWEBP_PATH to trusted binaries, or retry the download.",
      );
    }
  }
}

function candidateBinaryNames(binary: WebpBinary, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${binary}.exe`, binary] : [binary];
}

function executableName(binary: WebpBinary, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${binary}.exe` : binary;
}

function pathListDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function archiveInfoFor(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): WebpArchiveInfo | null {
  if (platform === "darwin" && arch === "arm64") {
    return archiveInfo(
      "mac-arm64",
      "bc6bf84cc70f3f8574fba797d1e4a7dea4feebe9fa4be919f202413ea2b3b8f2",
    );
  }
  if (platform === "darwin" && arch === "x64") {
    return archiveInfo(
      "mac-x86-64",
      "f112dd83b420ab2a4b27d46610d9827ddf4200216023281de378647ecca31c2a",
    );
  }
  if (platform === "linux" && arch === "arm64") {
    return archiveInfo(
      "linux-aarch64",
      "69f5eebe203e0f3942fe37986209a1725741be19c152950a4283b376c95ec798",
    );
  }
  if (platform === "linux" && arch === "x64") {
    return archiveInfo(
      "linux-x86-64",
      "1c5ffab71efecefa0e3c23516c3a3a1dccb45cc310ae1095c6f14ae268e38067",
    );
  }
  return null;
}

function archiveInfo(platformToken: string, sha256: string): WebpArchiveInfo {
  const directoryName = `libwebp-${LIBWEBP_VERSION}-${platformToken}`;
  return {
    directoryName,
    archiveName: `${directoryName}.tar.gz`,
    sha256,
  };
}

function envVarFor(binary: WebpBinary): string {
  return binary === "cwebp" ? ENV.CWEBP_PATH.name : ENV.DWEBP_PATH.name;
}

async function isExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch (error) {
    // Missing file or lacking the execute bit both mean this binary can't be used; treat either as "not executable".
    logger.debug(`src/utils/image/webp/WebpBinaryResolver.ts fallback failed: ${error}`, error);
    return false;
  }
}

async function waitForCompletion(
  child: ReturnType<HostProcessExecutor["spawn"]>,
  stdin: Writable,
  toolName: WebpBinary,
  envVar: string,
  stderr: Buffer[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      reject(actionableProcessError(toolName, envVar, error.message));
    });
    stdin.once("error", (error) => {
      reject(
        actionableProcessError(toolName, envVar, `stdin write failed: ${errorMessage(error)}`),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      const suffix = detail ? `: ${detail}` : "";
      reject(
        actionableProcessError(
          toolName,
          envVar,
          `exited with code ${code ?? "null"} signal ${signal ?? "null"}${suffix}`,
        ),
      );
    });
  });
}

function actionableProcessError(
  toolName: WebpBinary,
  envVar: string,
  detail: string,
): ActionableError {
  return new ActionableError(
    `${toolName} failed (${detail}). Set ${envVar} to a working ${toolName} binary.`,
  );
}

function defaultProjectRoot(): string {
  const candidates = [
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..") : null,
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..", "..") : null,
    process.cwd(),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, "vendor", "libwebp")) ||
      existsSync(path.join(candidate, "package.json"))
    ) {
      return candidate;
    }
  }
  return process.cwd();
}
