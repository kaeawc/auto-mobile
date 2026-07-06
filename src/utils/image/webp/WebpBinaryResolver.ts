import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { ActionableError } from "../../../models/ActionableError";
import { DefaultFileDownloader, type FileDownloader } from "../../FileDownloader";
import { DefaultProcessExecutor, type ProcessExecutor } from "../../ProcessExecutor";

const LIBWEBP_VERSION = "1.6.0";
const WEBP_DOWNLOAD_BASE_URL = "https://storage.googleapis.com/downloads.webmproject.org/releases/webp";

type WebpBinary = "cwebp" | "dwebp";

interface WebpArchiveInfo {
  archiveName: string;
  directoryName: string;
}

export interface WebpBinaryResolverOptions {
  projectRoot?: string;
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  fileDownloader?: FileDownloader;
  processExecutor?: ProcessExecutor;
}

export interface ResolvedWebpBinaries {
  cwebp: string;
  dwebp: string;
}

export interface WebpBinaryProvider {
  resolveCwebp(): Promise<string>;
  resolveDwebp(): Promise<string>;
}

export class WebpBinaryResolver implements WebpBinaryProvider {
  private readonly projectRoot: string;
  private readonly cacheDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fileDownloader: FileDownloader;
  private readonly processExecutor: ProcessExecutor;
  private readonly provisioningByArchive = new Map<string, Promise<void>>();

  constructor(options: WebpBinaryResolverOptions = {}) {
    this.projectRoot = options.projectRoot ?? defaultProjectRoot();
    this.cacheDir = options.cacheDir ?? path.join(os.homedir(), ".auto-mobile", "libwebp");
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.fileDownloader = options.fileDownloader ?? new DefaultFileDownloader();
    this.processExecutor = options.processExecutor ?? new DefaultProcessExecutor();
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

  private async resolveBinary(binary: WebpBinary, envVar: string): Promise<string> {
    const override = this.env[envVar]?.trim();
    if (override) {
      if (await isExecutableFile(override)) {
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
        if (await isExecutableFile(candidate)) {
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
    return await isExecutableFile(candidate) ? candidate : null;
  }

  private async findOrDownloadOffPlatformBinary(binary: WebpBinary): Promise<string | null> {
    const archive = archiveInfoFor(this.platform, this.arch);
    if (!archive) {
      return null;
    }

    const binaryPath = path.join(this.cacheDir, archive.directoryName, "bin", executableName(binary, this.platform));
    if (await isExecutableFile(binaryPath)) {
      return binaryPath;
    }

    await this.provisionArchiveOnce(archive);
    await fs.chmod(binaryPath, 0o755).catch(() => undefined);

    if (await isExecutableFile(binaryPath)) {
      return binaryPath;
    }

    throw new ActionableError(`Downloaded libwebp archive did not provide ${binary} at ${binaryPath}. Set ${envVarFor(binary)} instead.`);
  }

  private async provisionArchiveOnce(archive: WebpArchiveInfo): Promise<void> {
    const key = `${this.platform}-${this.arch}-${archive.archiveName}`;
    const existing = this.provisioningByArchive.get(key);
    if (existing) {
      await existing;
      return;
    }

    const provision = this.provisionArchive(archive).catch(error => {
      this.provisioningByArchive.delete(key);
      throw error;
    });
    this.provisioningByArchive.set(key, provision);
    await provision;
  }

  private async provisionArchive(archive: WebpArchiveInfo): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const archivePath = path.join(this.cacheDir, archive.archiveName);
    await this.fileDownloader.download(`${WEBP_DOWNLOAD_BASE_URL}/${archive.archiveName}`, archivePath);
    await this.processExecutor.exec(`tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(this.cacheDir)}`);
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
    return archiveInfo("mac-arm64");
  }
  if (platform === "darwin" && arch === "x64") {
    return archiveInfo("mac-x86-64");
  }
  if (platform === "linux" && arch === "arm64") {
    return archiveInfo("linux-aarch64");
  }
  if (platform === "linux" && arch === "x64") {
    return archiveInfo("linux-x86-64");
  }
  return null;
}

function archiveInfo(platformToken: string): WebpArchiveInfo {
  const directoryName = `libwebp-${LIBWEBP_VERSION}-${platformToken}`;
  return {
    directoryName,
    archiveName: `${directoryName}.tar.gz`
  };
}

function envVarFor(binary: WebpBinary): string {
  return binary === "cwebp" ? "AUTOMOBILE_CWEBP_PATH" : "AUTOMOBILE_DWEBP_PATH";
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
