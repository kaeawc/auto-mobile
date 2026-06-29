import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import {
  AppFileContainer,
  AppFileListRequest,
  AppFileListResult,
  AppFileReadRequest,
  AppFileReadResult,
  PutAppFileArgs,
  PutAppFileResult,
  buildAppFileResourceUri,
  normalizeAppFileRelativePath,
} from "./appFileContract";
import { ActionableError, BootedDevice, Platform } from "../models";
import { defaultAdbClientFactory, type AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";

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

export interface AppFileServiceDependencies {
  adbFactory?: AdbClientFactory;
  simctlFactory?: (device: BootedDevice) => SimCtlClient;
  providers?: AppFileProvider[];
  deviceResolver?: (deviceId: string) => Promise<BootedDevice>;
}

const defaultDependencies: Required<Pick<AppFileServiceDependencies, "adbFactory" | "simctlFactory" | "deviceResolver">> = {
  adbFactory: defaultAdbClientFactory,
  simctlFactory: device => new SimCtlClient(device),
  deviceResolver: findBootedDevice,
};

const ANDROID_APP_FILE_MAX_BUFFER = 64 * 1024 * 1024;

let appFileService: AppFileService | null = null;

export function getAppFileService(): AppFileService {
  if (!appFileService) {
    appFileService = new DefaultAppFileService(createDefaultProviders(defaultDependencies), defaultDependencies.deviceResolver);
  }
  return appFileService;
}

export function setAppFileServiceForTesting(service: AppFileService): void {
  appFileService = service;
}

export function resetAppFileServiceForTesting(): void {
  appFileService = null;
}

export function createAppFileServiceForTesting(deps: AppFileServiceDependencies = {}): AppFileService {
  const resolvedDeps = {
    adbFactory: deps.adbFactory ?? defaultDependencies.adbFactory,
    simctlFactory: deps.simctlFactory ?? defaultDependencies.simctlFactory,
    deviceResolver: deps.deviceResolver ?? defaultDependencies.deviceResolver,
  };
  return new DefaultAppFileService(
    deps.providers ?? createDefaultProviders(resolvedDeps),
    resolvedDeps.deviceResolver
  );
}

function createDefaultProviders(
  deps: Required<Pick<AppFileServiceDependencies, "adbFactory" | "simctlFactory">>
): AppFileProvider[] {
  return [
    new AndroidAppFileProvider(deps.adbFactory),
    new IosSimulatorAppFileProvider(deps.simctlFactory),
  ];
}

class DefaultAppFileService implements AppFileService {
  private readonly providersByPlatform = new Map<Platform, AppFileProvider>();

  constructor(
    providers: AppFileProvider[],
    private readonly deviceResolver: (deviceId: string) => Promise<BootedDevice>
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

  private getProvider(platform: Platform, operation: string, appId: string, container: AppFileContainer): AppFileProvider {
    const provider = this.providersByPlatform.get(platform);
    if (!provider) {
      throw unsupportedAppFileOperation(operation, platform, appId, container, "no app file provider is registered");
    }
    return provider;
  }

  private async prepareSource(args: PutAppFileArgs): Promise<FileSource> {
    if (args.sourcePath !== undefined) {
      const stat = await nodeFs.stat(args.sourcePath);
      if (!stat.isFile()) {
        throw new ActionableError(`sourcePath is not a file: ${args.sourcePath}`);
      }
      return { path: args.sourcePath, byteCount: stat.size };
    }

    const buffer = args.contentBase64 !== undefined
      ? Buffer.from(args.contentBase64, "base64")
      : Buffer.from(args.contentText ?? "", "utf8");
    const dir = await nodeFs.mkdtemp(join(tmpdir(), "automobile-app-file-"));
    const tempPath = join(dir, "content");
    await nodeFs.writeFile(tempPath, buffer);
    return {
      path: tempPath,
      byteCount: buffer.byteLength,
      cleanup: async () => {
        await nodeFs.rm(dir, { recursive: true, force: true });
      },
    };
  }
}

class AndroidAppFileProvider implements AppFileProvider {
  readonly platform = "android" as const;

  constructor(private readonly adbFactory: AdbClientFactory) {}

  async putFile(request: PutAppFileProviderRequest): Promise<void> {
    const adb = this.adbFactory.create(request.device);
    const target = resolveAndroidTarget(request.appId, request.container, request.destinationPath);
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation("putFile", request.device.platform, request.appId, request.container, target.message);
    }

    if (target.kind === "external") {
      await adb.executeCommand(`shell mkdir -p ${shellQuote(posix.dirname(target.absolutePath))}`, undefined, undefined, true, request.signal);
      await adb.executeCommand(`push ${shellQuote(request.sourcePath)} ${shellQuote(target.absolutePath)}`, undefined, undefined, true, request.signal);
      return;
    }

    const tempDevicePath = `/data/local/tmp/automobile-${randomUUID()}-${posix.basename(request.destinationPath)}`;
    await adb.executeCommand(`push ${shellQuote(request.sourcePath)} ${shellQuote(tempDevicePath)}`, undefined, undefined, true, request.signal);
    try {
      const command = `mkdir -p ${shellQuote(posix.dirname(target.relativePath))} && ` +
        `cp ${shellQuote(tempDevicePath)} ${shellQuote(target.relativePath)} && ` +
        `chmod 600 ${shellQuote(target.relativePath)}`;
      await adb.executeCommand(
        `shell run-as ${shellQuote(request.appId)} sh -c ${shellQuote(command)}`,
        undefined,
        undefined,
        true,
        request.signal
      );
    } finally {
      await adb.executeCommand(`shell rm -f ${shellQuote(tempDevicePath)}`, undefined, undefined, true, request.signal).catch(() => {});
    }
  }

  async listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult> {
    const adb = this.adbFactory.create(request.device);
    const base = resolveAndroidTarget(request.appId, request.container, "placeholder");
    if (base.kind === "unsupported") {
      throw unsupportedAppFileOperation("listFiles", request.device.platform, request.appId, request.container, base.message);
    }

    const stdout = base.kind === "external"
      ? (await adb.executeCommand(
        `shell if [ -d ${shellQuote(posix.dirname(base.absolutePath))} ]; then find ${shellQuote(posix.dirname(base.absolutePath))} -type f; fi`,
        undefined,
        ANDROID_APP_FILE_MAX_BUFFER,
        true
      )).stdout
      : (await adb.executeCommand(
        `shell run-as ${shellQuote(request.appId)} sh -c ${shellQuote(
          `if [ -d ${shellQuote(posix.dirname(base.relativePath))} ]; then find ${shellQuote(posix.dirname(base.relativePath))} -type f; fi`
        )}`,
        undefined,
        ANDROID_APP_FILE_MAX_BUFFER,
        true
      )).stdout;

    const root = base.kind === "external" ? posix.dirname(base.absolutePath) : posix.dirname(base.relativePath);
    const files = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(filePath => filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath)
      .map(path => ({
        path,
        resourceUri: buildAppFileResourceUri({
          deviceId: request.device.deviceId,
          appId: request.appId,
          container: request.container,
          path,
        }),
      }));

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
      throw unsupportedAppFileOperation("readFile", request.device.platform, request.appId, request.container, target.message);
    }

    const stdout = target.kind === "external"
      ? (await adb.executeCommand(
        `shell base64 ${shellQuote(target.absolutePath)}`,
        undefined,
        ANDROID_APP_FILE_MAX_BUFFER,
        true
      )).stdout
      : (await adb.executeCommand(
        `shell run-as ${shellQuote(request.appId)} base64 ${shellQuote(target.relativePath)}`,
        undefined,
        ANDROID_APP_FILE_MAX_BUFFER,
        true
      )).stdout;
    const blob = stdout.replace(/\s+/g, "");
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      path: request.path,
      byteCount: Buffer.from(blob, "base64").byteLength,
      mimeType: "application/octet-stream",
      blob,
    };
  }
}

class IosSimulatorAppFileProvider implements AppFileProvider {
  readonly platform = "ios" as const;

  constructor(private readonly simctlFactory: (device: BootedDevice) => SimCtlClient) {}

  async putFile(request: PutAppFileProviderRequest): Promise<void> {
    const target = await this.resolvePath(request.device, request.appId, request.container, request.destinationPath, "putFile");
    await nodeFs.mkdir(dirname(target), { recursive: true });
    await nodeFs.copyFile(request.sourcePath, target);
  }

  async listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult> {
    const root = await this.resolvePath(request.device, request.appId, request.container, undefined, "listFiles");
    const files = await listLocalFiles(root);
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      files: files.map(file => ({
        path: file.path,
        byteCount: file.byteCount,
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
    const target = await this.resolvePath(request.device, request.appId, request.container, request.path, "readFile");
    const buffer = await nodeFs.readFile(target);
    return {
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      appId: request.appId,
      container: request.container,
      path: request.path,
      byteCount: buffer.byteLength,
      mimeType: "application/octet-stream",
      blob: buffer.toString("base64"),
    };
  }

  private async resolvePath(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    path: string | undefined,
    operation: string
  ): Promise<string> {
    if (container === "externalFiles") {
      throw unsupportedAppFileOperation(operation, device.platform, appId, container, "externalFiles is not available for iOS app containers");
    }

    const simctl = this.simctlFactory(device);
    const result = await simctl.executeCommand(`get_app_container ${shellQuote(device.deviceId)} ${shellQuote(appId)} data`);
    const dataRoot = result.stdout.trim();
    if (!dataRoot) {
      throw new ActionableError(`Unable to resolve iOS app data container for ${appId} on ${device.deviceId}.`);
    }

    const containerRoot = join(dataRoot, iosContainerRelativePath(container, operation, appId, device.platform));
    return path === undefined ? containerRoot : join(containerRoot, normalizeAppFileRelativePath(path));
  }
}

async function findBootedDevice(deviceId: string): Promise<BootedDevice> {
  const manager = PlatformDeviceManagerFactory.getInstance();
  const devices = [
    ...(await manager.getBootedDevices("android")),
    ...(await manager.getBootedDevices("ios")),
  ];
  const device = devices.find(candidate => candidate.deviceId === deviceId);
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
    segments.some(segment => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ActionableError("appId must be a non-empty app identifier without path separators or traversal segments.");
  }
  return normalized;
}

function unsupportedAppFileOperation(
  operation: string,
  platform: Platform,
  appId: string,
  container: AppFileContainer,
  reason: string
): ActionableError {
  return new ActionableError(
    `${operation} is not supported for appId ${appId} in ${container} on ${platform}: ${reason}`
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type AndroidTarget =
  | { kind: "runAs"; relativePath: string }
  | { kind: "external"; absolutePath: string }
  | { kind: "unsupported"; message: string };

function resolveAndroidTarget(appId: string, container: AppFileContainer, path: string): AndroidTarget {
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
      return { kind: "unsupported", message: "library is not available for Android app containers. Use documents, cache, tmp, or externalFiles." };
  }
}

function iosContainerRelativePath(
  container: AppFileContainer,
  operation: string,
  appId: string,
  platform: Platform
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
      throw unsupportedAppFileOperation(operation, platform, appId, container, "externalFiles is not available for iOS app containers");
  }
}

async function listLocalFiles(root: string): Promise<Array<{ path: string; byteCount: number }>> {
  const entries: Array<{ path: string; byteCount: number }> = [];

  async function visit(dir: string): Promise<void> {
    const children = await nodeFs.readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const childPath = join(dir, child.name);
      if (child.isDirectory()) {
        await visit(childPath);
      } else if (child.isFile()) {
        const stat = await nodeFs.stat(childPath);
        entries.push({
          path: relative(root, childPath).replace(/\\/g, "/"),
          byteCount: stat.size,
        });
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
