import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { randomUUID } from "node:crypto";
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
import { ActionableError, BootedDevice } from "../models";
import { defaultAdbClientFactory, type AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";

export interface AppFileService {
  putFile(device: BootedDevice, args: PutAppFileArgs, signal?: AbortSignal): Promise<PutAppFileResult>;
  listFiles(request: AppFileListRequest): Promise<AppFileListResult>;
  readFile(request: AppFileReadRequest): Promise<AppFileReadResult>;
}

interface FileSource {
  path: string;
  byteCount: number;
  cleanup?: () => Promise<void>;
}

export interface AppFileServiceDependencies {
  adbFactory: AdbClientFactory;
  simctlFactory: (device: BootedDevice) => SimCtlClient;
}

const defaultDependencies: AppFileServiceDependencies = {
  adbFactory: defaultAdbClientFactory,
  simctlFactory: device => new SimCtlClient(device),
};

const ANDROID_APP_FILE_MAX_BUFFER = 64 * 1024 * 1024;

let appFileService: AppFileService | null = null;

export function getAppFileService(): AppFileService {
  if (!appFileService) {
    appFileService = new DefaultAppFileService(defaultDependencies);
  }
  return appFileService;
}

export function setAppFileServiceForTesting(service: AppFileService): void {
  appFileService = service;
}

export function resetAppFileServiceForTesting(): void {
  appFileService = null;
}

export function createAppFileServiceForTesting(deps: AppFileServiceDependencies): AppFileService {
  return new DefaultAppFileService(deps);
}

class DefaultAppFileService implements AppFileService {
  constructor(private readonly deps: AppFileServiceDependencies) {}

  async putFile(device: BootedDevice, args: PutAppFileArgs, signal?: AbortSignal): Promise<PutAppFileResult> {
    const destinationPath = normalizeAppFileRelativePath(args.destinationPath);
    const source = await this.prepareSource(args);
    try {
      if (device.platform === "android") {
        await this.putAndroidFile(device, args.appId, args.container, source.path, destinationPath, signal);
      } else if (device.platform === "ios") {
        await this.putIosFile(device, args.appId, args.container, source.path, destinationPath);
      } else {
        throw new ActionableError(`Unsupported platform: ${device.platform}`);
      }

      return {
        success: true,
        deviceId: device.deviceId,
        platform: device.platform,
        appId: args.appId,
        container: args.container,
        destinationPath,
        byteCount: source.byteCount,
        resourceUri: buildAppFileResourceUri({
          deviceId: device.deviceId,
          appId: args.appId,
          container: args.container,
          path: destinationPath,
        }),
      };
    } finally {
      await source.cleanup?.();
    }
  }

  async listFiles(request: AppFileListRequest): Promise<AppFileListResult> {
    const device = await findBootedDevice(request.deviceId);
    if (device.platform === "android") {
      return this.listAndroidFiles(device, request.appId, request.container);
    }
    if (device.platform === "ios") {
      return this.listIosFiles(device, request.appId, request.container);
    }
    throw new ActionableError(`Unsupported platform: ${device.platform}`);
  }

  async readFile(request: AppFileReadRequest): Promise<AppFileReadResult> {
    const path = normalizeAppFileRelativePath(request.path);
    const device = await findBootedDevice(request.deviceId);
    if (device.platform === "android") {
      return this.readAndroidFile(device, request.appId, request.container, path);
    }
    if (device.platform === "ios") {
      return this.readIosFile(device, request.appId, request.container, path);
    }
    throw new ActionableError(`Unsupported platform: ${device.platform}`);
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

  private async putAndroidFile(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    sourcePath: string,
    destinationPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const adb = this.deps.adbFactory.create(device);
    const target = resolveAndroidTarget(appId, container, destinationPath);
    if (target.kind === "unsupported") {
      throw new ActionableError(target.message);
    }

    if (target.kind === "external") {
      await adb.executeCommand(`shell mkdir -p ${shellQuote(posix.dirname(target.absolutePath))}`, undefined, undefined, true, signal);
      await adb.executeCommand(`push ${shellQuote(sourcePath)} ${shellQuote(target.absolutePath)}`, undefined, undefined, true, signal);
      return;
    }

    const tempDevicePath = `/data/local/tmp/automobile-${randomUUID()}-${posix.basename(destinationPath)}`;
    await adb.executeCommand(`push ${shellQuote(sourcePath)} ${shellQuote(tempDevicePath)}`, undefined, undefined, true, signal);
    try {
      const command = `mkdir -p ${shellQuote(posix.dirname(target.relativePath))} && ` +
        `cp ${shellQuote(tempDevicePath)} ${shellQuote(target.relativePath)} && ` +
        `chmod 600 ${shellQuote(target.relativePath)}`;
      await adb.executeCommand(
        `shell run-as ${shellQuote(appId)} sh -c ${shellQuote(command)}`,
        undefined,
        undefined,
        true,
        signal
      );
    } finally {
      await adb.executeCommand(`shell rm -f ${shellQuote(tempDevicePath)}`, undefined, undefined, true, signal).catch(() => {});
    }
  }

  private async listAndroidFiles(device: BootedDevice, appId: string, container: AppFileContainer): Promise<AppFileListResult> {
    const adb = this.deps.adbFactory.create(device);
    const base = resolveAndroidTarget(appId, container, "placeholder");
    if (base.kind === "unsupported") {
      throw new ActionableError(base.message);
    }

    const stdout = base.kind === "external"
      ? (await adb.executeCommand(
        `shell if [ -d ${shellQuote(posix.dirname(base.absolutePath))} ]; then find ${shellQuote(posix.dirname(base.absolutePath))} -type f; fi`,
        undefined,
        ANDROID_APP_FILE_MAX_BUFFER,
        true
      )).stdout
      : (await adb.executeCommand(
        `shell run-as ${shellQuote(appId)} sh -c ${shellQuote(
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
        resourceUri: buildAppFileResourceUri({ deviceId: device.deviceId, appId, container, path }),
      }));

    return { deviceId: device.deviceId, platform: device.platform, appId, container, files };
  }

  private async readAndroidFile(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    path: string
  ): Promise<AppFileReadResult> {
    const adb = this.deps.adbFactory.create(device);
    const target = resolveAndroidTarget(appId, container, path);
    if (target.kind === "unsupported") {
      throw new ActionableError(target.message);
    }

    const stdout = target.kind === "external"
      ? (await adb.executeCommand(
        `shell base64 ${shellQuote(target.absolutePath)}`,
        undefined,
        ANDROID_APP_FILE_MAX_BUFFER,
        true
      )).stdout
      : (await adb.executeCommand(
        `shell run-as ${shellQuote(appId)} base64 ${shellQuote(target.relativePath)}`,
        undefined,
        ANDROID_APP_FILE_MAX_BUFFER,
        true
      )).stdout;
    const blob = stdout.replace(/\s+/g, "");
    return {
      deviceId: device.deviceId,
      platform: device.platform,
      appId,
      container,
      path,
      byteCount: Buffer.from(blob, "base64").byteLength,
      mimeType: "application/octet-stream",
      blob,
    };
  }

  private async putIosFile(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    sourcePath: string,
    destinationPath: string
  ): Promise<void> {
    const target = await this.resolveIosPath(device, appId, container, destinationPath);
    await nodeFs.mkdir(dirname(target), { recursive: true });
    await nodeFs.copyFile(sourcePath, target);
  }

  private async listIosFiles(device: BootedDevice, appId: string, container: AppFileContainer): Promise<AppFileListResult> {
    const root = await this.resolveIosPath(device, appId, container);
    const files = await listLocalFiles(root);
    return {
      deviceId: device.deviceId,
      platform: device.platform,
      appId,
      container,
      files: files.map(file => ({
        path: file.path,
        byteCount: file.byteCount,
        resourceUri: buildAppFileResourceUri({ deviceId: device.deviceId, appId, container, path: file.path }),
      })),
    };
  }

  private async readIosFile(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    path: string
  ): Promise<AppFileReadResult> {
    const target = await this.resolveIosPath(device, appId, container, path);
    const buffer = await nodeFs.readFile(target);
    return {
      deviceId: device.deviceId,
      platform: device.platform,
      appId,
      container,
      path,
      byteCount: buffer.byteLength,
      mimeType: "application/octet-stream",
      blob: buffer.toString("base64"),
    };
  }

  private async resolveIosPath(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
    path?: string
  ): Promise<string> {
    if (container === "externalFiles") {
      throw new ActionableError("externalFiles is not supported for iOS app containers.");
    }

    const simctl = this.deps.simctlFactory(device);
    const result = await simctl.executeCommand(`get_app_container ${shellQuote(device.deviceId)} ${shellQuote(appId)} data`);
    const dataRoot = result.stdout.trim();
    if (!dataRoot) {
      throw new ActionableError(`Unable to resolve iOS app data container for ${appId} on ${device.deviceId}.`);
    }

    const containerRoot = join(dataRoot, iosContainerRelativePath(container));
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type AndroidTarget =
  | { kind: "runAs"; relativePath: string }
  | { kind: "external"; absolutePath: string }
  | { kind: "unsupported"; message: string };

function resolveAndroidTarget(appId: string, container: AppFileContainer, path: string): AndroidTarget {
  const safePath = normalizeAppFileRelativePath(path);
  validateAndroidAppIdForPath(appId);
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
      return { kind: "unsupported", message: "library is not supported for Android app containers. Use documents, cache, tmp, or externalFiles." };
  }
}

function validateAndroidAppIdForPath(appId: string): void {
  const segments = appId.split(".");
  if (
    appId.length === 0 ||
    appId.includes("/") ||
    appId.includes("\\") ||
    segments.some(segment => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ActionableError("appId must not contain path separators or traversal segments.");
  }
}

function iosContainerRelativePath(container: AppFileContainer): string {
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
      throw new ActionableError("externalFiles is not supported for iOS app containers.");
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
