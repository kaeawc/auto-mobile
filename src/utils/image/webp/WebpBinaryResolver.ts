import type { ChildProcess } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import { ActionableError } from "../../../models/ActionableError";
import { type ArchiveExtractor, DefaultArchiveExtractor } from "../../ArchiveExtractor";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../ChecksumCalculator";
import { DefaultFileDownloader, type FileDownloader } from "../../FileDownloader";
import { DefaultHostCommandExecutor, type HostProcessExecutor } from "../../HostCommandExecutor";
import { logger } from "../../logger";

const LIBWEBP_VERSION = "1.6.0";
const WEBP_DOWNLOAD_BASE_URL = "https://storage.googleapis.com/downloads.webmproject.org/releases/webp";
const archiveProvisioningByPath = new Map<string, Promise<void>>();

type WebpBinary = "cwebp" | "dwebp";

interface WebpArchiveInfo {
  archiveName: string;
  directoryName: string;
  sha256: string;
}

export interface WebpBinaryResolverOptions {
  projectRoot?: string;
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  fileDownloader?: FileDownloader;
  archiveExtractor?: ArchiveExtractor;
  processExecutor?: HostProcessExecutor;
  checksumCalculator?: ChecksumCalculator;
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
  private readonly projectRoot: string;
  private readonly cacheDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fileDownloader: FileDownloader;
  private readonly archiveExtractor: ArchiveExtractor;
  private readonly processExecutor: HostProcessExecutor;
  private readonly checksumCalculator: ChecksumCalculator;

  constructor(options: WebpBinaryResolverOptions = {}) {
    this.projectRoot = options.projectRoot ?? defaultProjectRoot();
    this.cacheDir = options.cacheDir ?? path.join(os.homedir(), ".auto-mobile", "libwebp");
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.fileDownloader = options.fileDownloader ?? new DefaultFileDownloader();
    this.archiveExtractor = options.archiveExtractor ?? new DefaultArchiveExtractor();
    this.processExecutor = options.processExecutor ?? new DefaultHostCommandExecutor();
    this.checksumCalculator = options.checksumCalculator ?? new DefaultChecksumCalculator();
  }

  async resolve(): Promise<ResolvedWebpBinaries> {
    const [cwebp, dwebp] = await Promise.all([this.resolveCwebp(), this.resolveDwebp()]);
    return { cwebp, dwebp };
  }

  async resolveCwebp(): Promise<string> {
    return this.resolveBinary("cwebp", "AUTOMOBILE_CWEBP_PATH");
  }

  async resolveDwebp(): Promise<string> {
    return this.resolveBinary("dwebp", "AUTOMOBILE_DWEBP_PATH");
  }

  async runCwebp(args: string[], input: Buffer): Promise<Buffer> {
    const command = await this.resolveCwebp();
    return this.runCodecProcess("cwebp", command, args, input, "AUTOMOBILE_CWEBP_PATH");
  }

  async runDwebp(args: string[], input: Buffer): Promise<Buffer> {
    const command = await this.resolveDwebp();
    return this.runCodecProcess("dwebp", command, args, input, "AUTOMOBILE_DWEBP_PATH");
  }

  private async runCodecProcess(
    toolName: WebpBinary,
    command: string,
    args: string[],
    input: Buffer,
    envVar: string
  ): Promise<Buffer> {
    const child = this.processExecutor.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new ActionableError(`${toolName} was spawned without piped stdio. Set ${envVar} to a working ${toolName} binary.`);
    }

    child.stdout.on("data", data => stdout.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    child.stderr.on("data", data => stderr.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    const completion = waitForCompletion(child, child.stdin, toolName, envVar, stderr);
    try {
      child.stdin.end(input);
    } catch (error) {
      throw actionableProcessError(toolName, envVar, `stdin write failed: ${errorMessage(error)}`);
    }

    await completion;
    return Buffer.concat(stdout);
  }

  private async resolveBinary(binary: WebpBinary, envVar: string): Promise<string> {
    const override = this.env[envVar]?.trim();
    if (override) {
      if (await isExecutableFile(override, this.platform)) {
        return override;
      }
      throw new ActionableError(`${envVar} points to '${override}', but that ${binary} binary is not executable or does not exist.`);
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
      `Unable to resolve ${binary}. Set ${envVar}, add ${binary} to PATH, or ensure the bundled vendor/libwebp/win32-x64 copy is present.`
    );
  }

  private async findOnPath(binary: WebpBinary): Promise<string | null> {
    const pathValue = this.env.PATH ?? this.env.Path ?? "";
    if (!pathValue) {
      return null;
    }

    for (const entry of pathValue.split(pathListDelimiter(this.platform))) {
      if (!entry) {
        continue;
      }
      for (const name of candidateBinaryNames(binary, this.platform)) {
        const candidate = path.join(entry, name);
        if (await isExecutableFile(candidate, this.platform)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private async findBundledWindowsBinary(binary: WebpBinary): Promise<string | null> {
    if (this.platform !== "win32" || this.arch !== "x64") {
      return null;
    }

    const candidate = path.join(this.projectRoot, "vendor", "libwebp", "win32-x64", `${binary}.exe`);
    return await isExecutableFile(candidate, this.platform) ? candidate : null;
  }

  private async findOrDownloadOffPlatformBinary(binary: WebpBinary): Promise<string | null> {
    const archive = archiveInfoFor(this.platform, this.arch);
    if (!archive) {
      return null;
    }

    const binaryPath = path.join(this.cacheDir, archive.directoryName, "bin", executableName(binary, this.platform));
    if (await isExecutableFile(binaryPath, this.platform)) {
      return binaryPath;
    }

    await this.provisionArchiveOnce(archive);
    await fs.chmod(binaryPath, 0o755).catch(() => undefined);

    if (await isExecutableFile(binaryPath, this.platform)) {
      return binaryPath;
    }

    throw new ActionableError(`Downloaded libwebp archive did not provide ${binary} at ${binaryPath}. Set ${envVarFor(binary)} instead.`);
  }

  private async provisionArchiveOnce(archive: WebpArchiveInfo): Promise<void> {
    const archivePath = path.resolve(this.cacheDir, archive.archiveName);
    const existing = archiveProvisioningByPath.get(archivePath);
    if (existing) {
      await existing;
      return;
    }

    const provision = this.provisionArchive(archive).finally(() => {
      archiveProvisioningByPath.delete(archivePath);
    });
    archiveProvisioningByPath.set(archivePath, provision);
    await provision;
  }

  private async provisionArchive(archive: WebpArchiveInfo): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const archivePath = path.join(this.cacheDir, archive.archiveName);
    await this.fileDownloader.download(`${WEBP_DOWNLOAD_BASE_URL}/${archive.archiveName}`, archivePath);
    await this.verifyArchiveChecksum(archive, archivePath);
    await this.archiveExtractor.extractTarGz({ archivePath, destinationDir: this.cacheDir });
  }

  private async verifyArchiveChecksum(archive: WebpArchiveInfo, archivePath: string): Promise<void> {
    let actualChecksum: string;
    try {
      const result = await this.checksumCalculator.computeFileSha256(archivePath);
      actualChecksum = result.checksum.toLowerCase();
    } catch (error) {
      throw new ActionableError(
        `Unable to verify downloaded libwebp archive ${archive.archiveName}: ${errorMessage(error)}. ` +
        "Set AUTOMOBILE_CWEBP_PATH and AUTOMOBILE_DWEBP_PATH to trusted binaries, or retry the download."
      );
    }

    const expectedChecksum = archive.sha256.toLowerCase();
    if (actualChecksum !== expectedChecksum) {
      throw new ActionableError(
        `Downloaded libwebp archive checksum verification failed for ${archive.archiveName}. ` +
        `Expected SHA-256 ${expectedChecksum}, got ${actualChecksum}. ` +
        "Set AUTOMOBILE_CWEBP_PATH and AUTOMOBILE_DWEBP_PATH to trusted binaries, or retry the download."
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

function archiveInfoFor(platform: NodeJS.Platform, arch: NodeJS.Architecture): WebpArchiveInfo | null {
  if (platform === "darwin" && arch === "arm64") {
    return archiveInfo("mac-arm64", "bc6bf84cc70f3f8574fba797d1e4a7dea4feebe9fa4be919f202413ea2b3b8f2");
  }
  if (platform === "darwin" && arch === "x64") {
    return archiveInfo("mac-x86-64", "f112dd83b420ab2a4b27d46610d9827ddf4200216023281de378647ecca31c2a");
  }
  if (platform === "linux" && arch === "arm64") {
    return archiveInfo("linux-aarch64", "69f5eebe203e0f3942fe37986209a1725741be19c152950a4283b376c95ec798");
  }
  if (platform === "linux" && arch === "x64") {
    return archiveInfo("linux-x86-64", "1c5ffab71efecefa0e3c23516c3a3a1dccb45cc310ae1095c6f14ae268e38067");
  }
  return null;
}

function archiveInfo(platformToken: string, sha256: string): WebpArchiveInfo {
  const directoryName = `libwebp-${LIBWEBP_VERSION}-${platformToken}`;
  return {
    directoryName,
    archiveName: `${directoryName}.tar.gz`,
    sha256
  };
}

function envVarFor(binary: WebpBinary): string {
  return binary === "cwebp" ? "AUTOMOBILE_CWEBP_PATH" : "AUTOMOBILE_DWEBP_PATH";
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
  child: ChildProcess,
  stdin: Writable,
  toolName: WebpBinary,
  envVar: string,
  stderr: Buffer[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", error => {
      reject(actionableProcessError(toolName, envVar, error.message));
    });
    stdin.once("error", error => {
      reject(actionableProcessError(toolName, envVar, `stdin write failed: ${errorMessage(error)}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      const suffix = detail ? `: ${detail}` : "";
      reject(actionableProcessError(toolName, envVar, `exited with code ${code ?? "null"} signal ${signal ?? "null"}${suffix}`));
    });
  });
}

function actionableProcessError(toolName: WebpBinary, envVar: string, detail: string): ActionableError {
  return new ActionableError(`${toolName} failed (${detail}). Set ${envVar} to a working ${toolName} binary.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultProjectRoot(): string {
  const candidates = [
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..") : null,
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "..", "..") : null,
    process.cwd()
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "vendor", "libwebp")) || existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return process.cwd();
}
