import { errorMessage } from "../utils/describeUnknownError";
import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { TextDecoder } from "node:util";
import {
  AppFileContainer,
  AppFileListEntry,
  AppFileListRequest,
  AppFileListResult,
  AppFileReadRequest,
  AppFileReadResult,
  PutAppFileArgs,
  PutAppFileResult,
  buildAppFileResourceUri,
  normalizeAppFileRelativePath,
} from "./appFileContract";
import { ActionableError, BootedDevice, Platform, type ExecResult } from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import { shellQuote } from "../utils/shellQuote";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { logger } from "../utils/logger";

export interface PutAppFileRequest extends PutAppFileArgs {
  device: BootedDevice;
  signal?: AbortSignal;
}

export interface PutAppFileProviderRequest {
  device: BootedDevice;
  appId: string;
  container: AppFileContainer;
  destinationPath: string;
  sourcePath: string;
  byteCount: number;
  signal?: AbortSignal;
}

export interface AppFileProviderListRequest extends AppFileListRequest {
  device: BootedDevice;
}

export interface AppFileProviderReadRequest extends AppFileReadRequest {
  device: BootedDevice;
  path: string;
}

export interface AppFileProvider {
  readonly platform: Platform;
  putFile(request: PutAppFileProviderRequest): Promise<void>;
  listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult>;
  readFile(request: AppFileProviderReadRequest): Promise<AppFileReadResult>;
}

export interface AppFileService {
  putFile(request: PutAppFileRequest): Promise<PutAppFileResult>;
  listFiles(request: AppFileListRequest): Promise<AppFileListResult>;
  readFile(request: AppFileReadRequest): Promise<AppFileReadResult>;
}

interface FileSource {
  path: string;
  byteCount: number;
  cleanup?: () => Promise<void>;
}

export interface AppFileStats {
  size: number;
  mtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface AppFileDirEntry {
  name: string;
}

export interface AppFileFileSystem {
  stat(path: string): Promise<AppFileStats>;
  lstat(path: string): Promise<AppFileStats>;
  readdir(path: string): Promise<AppFileDirEntry[]>;
  mkdir(path: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  readFileBuffer(path: string): Promise<Buffer>;
  writeFileBuffer(path: string, data: Buffer): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
}

export interface AppFileServiceDependencies {
  adbFactory?: AdbClientFactory;
  simctlFactory?: (device: BootedDevice) => SimCtlClient;
  fileSystem?: AppFileFileSystem;
  providers?: AppFileProvider[];
  deviceResolver?: (deviceId: string) => Promise<BootedDevice>;
  idGenerator?: IdGenerator;
}

const nodeAppFileFileSystem: AppFileFileSystem = {
  stat: async (path) => nodeFs.stat(path),
  lstat: async (path) => nodeFs.lstat(path),
  readdir: async (path) => nodeFs.readdir(path, { withFileTypes: true }),
  mkdir: async (path) => {
    await nodeFs.mkdir(path, { recursive: true });
  },
  copyFile: async (sourcePath, destinationPath) => {
    await nodeFs.copyFile(sourcePath, destinationPath);
  },
  readFileBuffer: async (path) => nodeFs.readFile(path),
  writeFileBuffer: async (path, data) => {
    await nodeFs.writeFile(path, data);
  },
  mkdtemp: async (prefix) => nodeFs.mkdtemp(prefix),
  rm: async (path) => {
    await nodeFs.rm(path, { recursive: true, force: true });
  },
};

const defaultDependencies: Required<
  Pick<AppFileServiceDependencies, "adbFactory" | "simctlFactory" | "fileSystem" | "deviceResolver">
> = {
  adbFactory: defaultAdbClientFactory,
  simctlFactory: (device) => new SimCtlClient(device),
  fileSystem: nodeAppFileFileSystem,
  deviceResolver: findBootedDevice,
};

const ANDROID_APP_FILE_MAX_BUFFER = 64 * 1024 * 1024;

let appFileService: AppFileService | null = null;

export function getAppFileService(): AppFileService {
  if (!appFileService) {
    appFileService = new DefaultAppFileService(
      createDefaultProviders(defaultDependencies),
      defaultDependencies.deviceResolver,
      defaultDependencies.fileSystem,
    );
  }
  return appFileService;
}

export function setAppFileServiceForTesting(service: AppFileService): void {
  appFileService = service;
}

export function resetAppFileServiceForTesting(): void {
  appFileService = null;
}

export function createAppFileServiceForTesting(
  deps: AppFileServiceDependencies = {},
): AppFileService {
  const resolvedDeps = {
    adbFactory: deps.adbFactory ?? defaultDependencies.adbFactory,
    simctlFactory: deps.simctlFactory ?? defaultDependencies.simctlFactory,
    fileSystem: deps.fileSystem ?? defaultDependencies.fileSystem,
    deviceResolver: deps.deviceResolver ?? defaultDependencies.deviceResolver,
  };
  return new DefaultAppFileService(
    deps.providers ?? createDefaultProviders(resolvedDeps, deps.idGenerator ?? defaultIdGenerator),
    resolvedDeps.deviceResolver,
    resolvedDeps.fileSystem,
  );
}

function createDefaultProviders(
  deps: Required<Pick<AppFileServiceDependencies, "adbFactory" | "simctlFactory" | "fileSystem">>,
  idGenerator: IdGenerator = defaultIdGenerator,
): AppFileProvider[] {
  return [
    new AndroidAppFileProvider(deps.adbFactory, idGenerator),
    new IosSimulatorAppFileProvider(deps.simctlFactory, deps.fileSystem),
  ];
}

class DefaultAppFileService implements AppFileService {
  private readonly providersByPlatform = new Map<Platform, AppFileProvider>();

  constructor(
    providers: AppFileProvider[],
    private readonly deviceResolver: (deviceId: string) => Promise<BootedDevice>,
    private readonly fileSystem: AppFileFileSystem,
  ) {
    for (const provider of providers) {
      this.providersByPlatform.set(provider.platform, provider);
    }
  }

  async putFile(request: PutAppFileRequest): Promise<PutAppFileResult> {
    const appId = normalizeAppId(request.appId);
    const destinationPath = normalizeAppFileRelativePath(request.destinationPath);
    const provider = this.getProvider(request.device.platform, "putFile", appId, request.container);
    const source = await this.prepareSource(request);
    try {
      await provider.putFile({
        device: request.device,
        appId,
        container: request.container,
        destinationPath,
        sourcePath: source.path,
        byteCount: source.byteCount,
        signal: request.signal,
      });

      return {
        success: true,
        deviceId: request.device.deviceId,
        platform: request.device.platform,
        appId,
        container: request.container,
        destinationPath,
        byteCount: source.byteCount,
        resourceUri: buildAppFileResourceUri({
          deviceId: request.device.deviceId,
          appId,
          container: request.container,
          path: destinationPath,
        }),
      };
    } finally {
      await source.cleanup?.();
    }
  }

  async listFiles(request: AppFileListRequest): Promise<AppFileListResult> {
    const appId = normalizeAppId(request.appId);
    const device = await this.deviceResolver(request.deviceId);
    const provider = this.getProvider(device.platform, "listFiles", appId, request.container);
    return provider.listFiles({
      device,
      deviceId: device.deviceId,
      appId,
      container: request.container,
    });
  }

  async readFile(request: AppFileReadRequest): Promise<AppFileReadResult> {
    const appId = normalizeAppId(request.appId);
    const path = normalizeAppFileRelativePath(request.path);
    const device = await this.deviceResolver(request.deviceId);
    const provider = this.getProvider(device.platform, "readFile", appId, request.container);
    return provider.readFile({
      device,
      deviceId: device.deviceId,
      appId,
      container: request.container,
      path,
    });
  }

  private getProvider(
    platform: Platform,
    operation: string,
    appId: string,
    container: AppFileContainer,
  ): AppFileProvider {
    const provider = this.providersByPlatform.get(platform);
    if (!provider) {
      throw unsupportedAppFileOperation(
        operation,
        platform,
        appId,
        container,
        "no app file provider is registered",
      );
    }
    return provider;
  }

  private async prepareSource(args: PutAppFileArgs): Promise<FileSource> {
    if (args.sourcePath !== undefined) {
      const sourcePath = resolvePathFromDaemonLaunchWorkingDirectory(args.sourcePath);
      const stat = await this.fileSystem.stat(sourcePath);
      if (!stat.isFile()) {
        throw new ActionableError(`sourcePath is not a file: ${sourcePath}`);
      }
      return { path: sourcePath, byteCount: stat.size };
    }

    const buffer =
      args.contentBase64 !== undefined
        ? Buffer.from(args.contentBase64, "base64")
        : Buffer.from(args.contentText ?? "", "utf8");
    const dir = await this.fileSystem.mkdtemp(join(tmpdir(), "automobile-app-file-"));
    const tempPath = join(dir, "content");
    await this.fileSystem.writeFileBuffer(tempPath, buffer);
    return {
      path: tempPath,
      byteCount: buffer.byteLength,
      cleanup: async () => {
        await this.fileSystem.rm(dir);
      },
    };
  }
}

class AndroidAppFileProvider implements AppFileProvider {
  readonly platform = "android" as const;

  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<void> {
    const adb = this.adbFactory.create(request.device);
    const target = resolveAndroidTarget(request.appId, request.container, request.destinationPath);
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "putFile",
        request.device.platform,
        request.appId,
        request.container,
        target.message,
      );
    }

    if (target.kind === "external") {
      await executeAndroidAppFileCommand(
        adb,
        `shell mkdir -p ${shellQuote(posix.dirname(target.absolutePath))}`,
        {
          device: request.device,
          appId: request.appId,
          container: request.container,
          operation: "write",
          access: "externalFiles",
        },
        { noRetry: true, signal: request.signal },
      );
      await executeAndroidAppFileCommand(
        adb,
        `push ${shellQuote(request.sourcePath)} ${shellQuote(target.absolutePath)}`,
        {
          device: request.device,
          appId: request.appId,
          container: request.container,
          operation: "write",
          access: "externalFiles",
        },
        { noRetry: true, signal: request.signal },
      );
      return;
    }

    const tempDevicePath = `/data/local/tmp/automobile-${this.idGenerator.next()}-${posix.basename(request.destinationPath)}`;
    await executeAndroidAppFileCommand(
      adb,
      `push ${shellQuote(request.sourcePath)} ${shellQuote(tempDevicePath)}`,
      {
        device: request.device,
        appId: request.appId,
        container: request.container,
        operation: "write",
        access: "run-as",
      },
      { noRetry: true, signal: request.signal },
    );
    try {
      const command =
        `mkdir -p ${shellQuote(posix.dirname(target.relativePath))} && ` +
        `cp ${shellQuote(tempDevicePath)} ${shellQuote(target.relativePath)} && ` +
        `chmod 600 ${shellQuote(target.relativePath)}`;
      await executeAndroidAppFileCommand(
        adb,
        `shell run-as ${shellQuote(request.appId)} sh -c ${shellQuote(command)}`,
        {
          device: request.device,
          appId: request.appId,
          container: request.container,
          operation: "write",
          access: "run-as",
        },
        { noRetry: true, signal: request.signal },
      );
    } finally {
      await adb
        .executeCommand(
          `shell rm -f ${shellQuote(tempDevicePath)}`,
          undefined,
          undefined,
          true,
          request.signal,
        )
        .catch(() => {});
    }
  }

  async listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult> {
    const adb = this.adbFactory.create(request.device);
    const base = resolveAndroidTarget(request.appId, request.container, "placeholder");
    if (base.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "listFiles",
        request.device.platform,
        request.appId,
        request.container,
        base.message,
      );
    }

    const root =
      base.kind === "external"
        ? posix.dirname(base.absolutePath)
        : posix.dirname(base.relativePath);
    const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -exec stat -c '%F|%s|%Y|%n' {} \\; ; fi`;
    const stdout =
      base.kind === "external"
        ? (
            await executeAndroidAppFileCommand(
              adb,
              `shell ${script}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "list",
                access: "externalFiles",
              },
              { maxBuffer: ANDROID_APP_FILE_MAX_BUFFER, noRetry: true },
            )
          ).stdout
        : (
            await executeAndroidAppFileCommand(
              adb,
              `shell run-as ${shellQuote(request.appId)} sh -c ${shellQuote(script)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "list",
                access: "run-as",
              },
              { maxBuffer: ANDROID_APP_FILE_MAX_BUFFER, noRetry: true },
            )
          ).stdout;

    const files = parseAndroidStatListing(
      stdout,
      root,
      request.device,
      request.appId,
      request.container,
    );

    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      files,
    };
  }

  async readFile(request: AppFileProviderReadRequest): Promise<AppFileReadResult> {
    const adb = this.adbFactory.create(request.device);
    const target = resolveAndroidTarget(request.appId, request.container, request.path);
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "readFile",
        request.device.platform,
        request.appId,
        request.container,
        target.message,
      );
    }

    const stdout =
      target.kind === "external"
        ? (
            await executeAndroidAppFileCommand(
              adb,
              `shell base64 ${shellQuote(target.absolutePath)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "read",
                access: "externalFiles",
              },
              { maxBuffer: ANDROID_APP_FILE_MAX_BUFFER, noRetry: true },
            )
          ).stdout
        : (
            await executeAndroidAppFileCommand(
              adb,
              `shell run-as ${shellQuote(request.appId)} base64 ${shellQuote(target.relativePath)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "read",
                access: "run-as",
              },
              { maxBuffer: ANDROID_APP_FILE_MAX_BUFFER, noRetry: true },
            )
          ).stdout;
    const blob = stdout.replace(/\s+/g, "");
    const buffer = Buffer.from(blob, "base64");
    const text = decodeUtf8Text(buffer);
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      path: request.path,
      byteCount: buffer.byteLength,
      ...(text === undefined
        ? { mimeType: "application/octet-stream", blob }
        : { mimeType: "text/plain; charset=utf-8", text }),
    };
  }
}

class IosSimulatorAppFileProvider implements AppFileProvider {
  readonly platform = "ios" as const;

  constructor(
    private readonly simctlFactory: (device: BootedDevice) => SimCtlClient,
    private readonly fileSystem: AppFileFileSystem,
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<void> {
    const target = await this.resolvePath(
      request.device,
      request.appId,
      request.container,
      request.destinationPath,
      "putFile",
    );
    await this.fileSystem.mkdir(dirname(target));
    await this.fileSystem.copyFile(request.sourcePath, target);
  }

  async listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult> {
    const root = await this.resolvePath(
      request.device,
      request.appId,
      request.container,
      undefined,
      "listFiles",
    );
    const files = await listLocalFiles(root, this.fileSystem);
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      files: files.map((file) => ({
        ...file,
        resourceUri: buildAppFileResourceUri({
          deviceId: request.device.deviceId,
          appId: request.appId,
          container: request.container,
          path: file.path,
        }),
      })),
    };
  }

  async readFile(request: AppFileProviderReadRequest): Promise<AppFileReadResult> {
    const target = await this.resolvePath(
      request.device,
      request.appId,
      request.container,
      request.path,
      "readFile",
    );
    const buffer = await this.fileSystem.readFileBuffer(target);
    const text = decodeUtf8Text(buffer);
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      path: request.path,
      byteCount: buffer.byteLength,
      ...(text === undefined
        ? { mimeType: "application/octet-stream", blob: buffer.toString("base64") }
        : { mimeType: "text/plain; charset=utf-8", text }),
    };
  }

  private async resolvePath(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    path: string | undefined,
    operation: string,
  ): Promise<string> {
    if (container === "externalFiles") {
      throw unsupportedAppFileOperation(
        operation,
        device.platform,
        appId,
        container,
        "externalFiles is not available for iOS app containers",
      );
    }

    if (!isIosSimulatorUdid(device.deviceId)) {
      throw new ActionableError(
        `iOS app file ${operation} is only supported on iOS simulators. ` +
          `Device ${device.deviceId} looks like a physical iOS device; app data containers require xcrun simctl.`,
      );
    }

    const simctl = this.simctlFactory(device);
    const result = await executeIosAppContainerCommand(
      simctl,
      `get_app_container ${shellQuote(device.deviceId)} ${shellQuote(appId)} data`,
      { device, appId, container, operation },
    );
    const dataRoot = result.stdout.trim();
    if (!dataRoot) {
      throw new ActionableError(
        `Unable to resolve iOS simulator app data container for ${appId} on ${device.deviceId}. ` +
          "Confirm the simulator is booted and the app is installed.",
      );
    }

    const containerRoot = join(
      dataRoot,
      iosContainerRelativePath(container, operation, appId, device.platform),
    );
    return path === undefined
      ? containerRoot
      : join(containerRoot, normalizeAppFileRelativePath(path));
  }
}

async function findBootedDevice(deviceId: string): Promise<BootedDevice> {
  const manager = PlatformDeviceManagerFactory.getInstance();
  const devices = [
    ...(await manager.getBootedDevices("android")),
    ...(await manager.getBootedDevices("ios")),
  ];
  const device = devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    throw new ActionableError(`Device not found or not booted: ${deviceId}`);
  }
  return device;
}

function normalizeAppId(appId: string): string {
  const normalized = appId.trim();
  const segments = normalized.split(".");
  if (
    normalized.length === 0 ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ActionableError(
      "appId must be a non-empty app identifier without path separators or traversal segments.",
    );
  }
  return normalized;
}

function unsupportedAppFileOperation(
  operation: string,
  platform: Platform,
  appId: string,
  container: AppFileContainer,
  reason: string,
): ActionableError {
  return new ActionableError(
    `${operation} is not supported for appId ${appId} in ${container} on ${platform}: ${reason}`,
  );
}

type AndroidTarget =
  | { kind: "runAs"; relativePath: string }
  | { kind: "external"; absolutePath: string }
  | { kind: "unsupported"; message: string };

function resolveAndroidTarget(
  appId: string,
  container: AppFileContainer,
  path: string,
): AndroidTarget {
  const safePath = normalizeAppFileRelativePath(path);
  switch (container) {
    case "documents":
      return { kind: "runAs", relativePath: posix.join("files", safePath) };
    case "cache":
      return { kind: "runAs", relativePath: posix.join("cache", safePath) };
    case "tmp":
      return { kind: "runAs", relativePath: posix.join("cache", "tmp", safePath) };
    case "externalFiles":
      return { kind: "external", absolutePath: `/sdcard/Android/data/${appId}/files/${safePath}` };
    case "library":
      return {
        kind: "unsupported",
        message:
          "library is not available for Android app containers. Use documents, cache, tmp, or externalFiles.",
      };
  }
}

function iosContainerRelativePath(
  container: AppFileContainer,
  operation: string,
  appId: string,
  platform: Platform,
): string {
  switch (container) {
    case "documents":
      return "Documents";
    case "library":
      return "Library";
    case "cache":
      return join("Library", "Caches");
    case "tmp":
      return "tmp";
    case "externalFiles":
      throw unsupportedAppFileOperation(
        operation,
        platform,
        appId,
        container,
        "externalFiles is not available for iOS app containers",
      );
  }
}

type LocalFileListEntry = Omit<AppFileListEntry, "resourceUri">;

async function listLocalFiles(
  root: string,
  fileSystem: AppFileFileSystem,
): Promise<LocalFileListEntry[]> {
  const entries: LocalFileListEntry[] = [];

  async function visit(dir: string): Promise<void> {
    const children = await fileSystem.readdir(dir);
    for (const child of children) {
      const childPath = join(dir, child.name);
      const stat = await fileSystem.lstat(childPath);
      if (stat.isDirectory()) {
        entries.push(buildLocalListEntry(root, childPath, stat, true));
        await visit(childPath);
      } else if (stat.isFile()) {
        entries.push(buildLocalListEntry(root, childPath, stat, false));
      }
    }
  }

  try {
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return entries;
}

function buildLocalListEntry(
  root: string,
  childPath: string,
  stat: AppFileStats,
  isDirectory: boolean,
): LocalFileListEntry {
  const filePath = relative(root, childPath).replace(/\\/g, "/");
  return {
    path: filePath,
    name: posix.basename(filePath),
    ...(isDirectory ? {} : { byteCount: stat.size }),
    isDirectory,
    lastModified: stat.mtime.toISOString(),
  };
}

interface IosAppContainerCommandContext {
  device: BootedDevice;
  appId: string;
  container: AppFileContainer;
  operation: string;
}

async function executeIosAppContainerCommand(
  simctl: SimCtlClient,
  command: string,
  context: IosAppContainerCommandContext,
): Promise<ExecResult> {
  try {
    return await simctl.executeCommand(command);
  } catch (error) {
    throw mapIosAppContainerError(error, context);
  }
}

function mapIosAppContainerError(
  error: unknown,
  context: IosAppContainerCommandContext,
): ActionableError {
  const message = errorMessage(error);
  if (
    /not installed|application.*not.*installed|no such app|bundle.*not found|missing bundle/i.test(
      message,
    )
  ) {
    return new ActionableError(
      `iOS app ${context.appId} is not installed on simulator ${context.device.deviceId}; ` +
        `cannot ${context.operation} ${context.container} app files. Original error: ${message}`,
    );
  }

  if (/no such device|invalid device|unavailable|shutdown|not booted/i.test(message)) {
    return new ActionableError(
      `iOS simulator ${context.device.deviceId} is unavailable or not booted; ` +
        `cannot ${context.operation} ${context.container} app files for ${context.appId}. Original error: ${message}`,
    );
  }

  if (/docker|iOS simulator tooling is only available on macOS/i.test(message)) {
    return new ActionableError(
      `iOS simulator app file ${context.operation} requires local macOS simctl access; ` +
        `Docker-to-host simulator access is unsupported. Original error: ${message}`,
    );
  }

  return new ActionableError(
    `Failed to ${context.operation} iOS simulator ${context.container} app files for ` +
      `${context.appId} on ${context.device.deviceId}: ${message}`,
  );
}

function parseAndroidStatListing(
  stdout: string,
  root: string,
  device: BootedDevice,
  appId: string,
  container: AppFileContainer,
): AppFileListEntry[] {
  return stdout
    .split(/\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => parseAndroidStatLine(line, root, device, appId, container))
    .filter((entry): entry is AppFileListEntry => entry !== null);
}

function parseAndroidStatLine(
  line: string,
  root: string,
  device: BootedDevice,
  appId: string,
  container: AppFileContainer,
): AppFileListEntry | null {
  const parts = line.split("|");
  if (parts.length < 4) {
    return null;
  }

  const [fileType, sizeText, modifiedSecondsText, ...pathParts] = parts;
  const absolutePath = pathParts.join("|");
  if (absolutePath === root) {
    return null;
  }

  const relativePath = absolutePath.startsWith(`${root}/`)
    ? absolutePath.slice(root.length + 1)
    : absolutePath;
  const path = normalizeAppFileRelativePath(relativePath);
  const isDirectory = fileType.toLowerCase().includes("directory");
  const byteCount = Number(sizeText);
  const modifiedSeconds = Number(modifiedSecondsText);

  return {
    path,
    name: posix.basename(path),
    ...(isDirectory || !Number.isFinite(byteCount) ? {} : { byteCount }),
    isDirectory,
    ...(Number.isFinite(modifiedSeconds)
      ? { lastModified: new Date(modifiedSeconds * 1000).toISOString() }
      : {}),
    resourceUri: buildAppFileResourceUri({ deviceId: device.deviceId, appId, container, path }),
  };
}

interface AndroidAppFileCommandContext {
  device: BootedDevice;
  appId: string;
  container: AppFileContainer;
  operation: "write" | "list" | "read";
  access: "externalFiles" | "run-as";
}

interface AndroidAppFileExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  noRetry?: boolean;
  signal?: AbortSignal;
}

async function executeAndroidAppFileCommand(
  adb: AdbExecutor,
  command: string,
  context: AndroidAppFileCommandContext,
  options: AndroidAppFileExecOptions = {},
): Promise<ExecResult> {
  try {
    return await adb.executeCommand(
      command,
      options.timeoutMs,
      options.maxBuffer,
      options.noRetry,
      options.signal,
    );
  } catch (error) {
    throw mapAndroidAppFileError(error, context);
  }
}

function mapAndroidAppFileError(
  error: unknown,
  context: AndroidAppFileCommandContext,
): ActionableError {
  const message = errorMessage(error);
  if (/not debuggable/i.test(message)) {
    return new ActionableError(
      `Android ${context.container} app file ${context.operation} for ${context.appId} on ${context.device.deviceId} ` +
        "requires a debuggable app build because it uses run-as. Install a debuggable build or use externalFiles. " +
        `Original error: ${message}`,
    );
  }

  if (
    /package .* (unknown|not found)|unknown package|not installed|does not exist/i.test(message)
  ) {
    return new ActionableError(
      `Android app ${context.appId} is not installed on ${context.device.deviceId}; ` +
        `cannot ${context.operation} ${context.container} app files. Original error: ${message}`,
    );
  }

  if (/permission denied|operation not permitted/i.test(message)) {
    return new ActionableError(
      `Android ${context.container} app file ${context.operation} for ${context.appId} on ${context.device.deviceId} ` +
        `was denied by the device. ${context.access === "run-as" ? "Use a debuggable build for private storage or choose externalFiles." : "Check app install state and external storage access."} ` +
        `Original error: ${message}`,
    );
  }

  return new ActionableError(
    `Failed to ${context.operation} Android ${context.container} app files for ${context.appId} on ${context.device.deviceId}: ${message}`,
  );
}

function decodeUtf8Text(buffer: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    return text.includes("\u0000") ? undefined : text;
  } catch (error) {
    // Strict UTF-8 decoding throws on binary/invalid-encoding data; undefined
    // tells the caller to treat the file as binary instead of as text.
    logger.debug(`src/server/appFileService.ts utf8 decode failed: ${error}`, error);
    return undefined;
  }
}
