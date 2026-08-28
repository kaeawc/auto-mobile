import { errorMessage } from "../utils/describeUnknownError";
import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative } from "node:path";
import { TextDecoder } from "node:util";
import {
  AppFileContainer,
  AppFileListEntry,
  AppFileListRequest,
  AppFileListResult,
  AppFileReadRequest,
  AppFileReadResult,
  AppContainersTarget,
  LegacyPutAppFileArgs,
  PutAppFileArgs,
  PutAppFileBatchResult,
  PutAppFileInput,
  PutAppFileResult,
  PutAppFileTarget,
  PutAppFileWriteResult,
  StorageDomain,
  buildAppFileResourceUri,
  hasSupportedSimulatorMediaExtension,
  normalizeAppFileRelativePath,
  normalizePutAppFileTarget,
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
import { logger } from "../utils/logger";
import { prepareFileSource } from "./fileSourcePreparation";
import { getSharedStorageService, type SharedStorageService } from "./sharedStorageService";
import {
  SimctlIosSimulatorMediaClient,
  type IosSimulatorMediaClient,
} from "./iosSimulatorMediaClient";

export type PutAppFileRequest = Omit<PutAppFileArgs, "device"> & {
  device: BootedDevice;
  signal?: AbortSignal;
};

export type LegacyPutAppFileRequest = Omit<LegacyPutAppFileArgs, "device"> & {
  device: BootedDevice;
  signal?: AbortSignal;
};

export interface PutAppFileProviderRequest {
  device: BootedDevice;
  target: PutAppFileTarget;
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

export interface AppFileWriteProvider {
  readonly platform: Platform;
  readonly domain: StorageDomain;
  putFile(
    request: PutAppFileProviderRequest,
  ): Promise<void | { effects?: PutAppFileWriteResult["effects"] }>;
  /**
   * Optional batch path for providers whose device operation must use one
   * consistent target (for example, a single Android user profile).
   */
  putFiles?(
    requests: PutAppFileProviderRequest[],
  ): Promise<Array<void | { effects?: PutAppFileWriteResult["effects"] }>>;
}

export interface AppFileListProvider {
  readonly platform: Platform;
  readonly domain: "app_containers";
  listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult>;
}

export interface AppFileReadProvider {
  readonly platform: Platform;
  readonly domain: "app_containers";
  readFile(request: AppFileProviderReadRequest): Promise<AppFileReadResult>;
}

export type AppFileProvider = AppFileWriteProvider | AppFileListProvider | AppFileReadProvider;

export interface AppFileService {
  putFile(request: PutAppFileRequest): Promise<PutAppFileBatchResult>;
  putFile(request: LegacyPutAppFileRequest): Promise<PutAppFileResult>;
  listFiles(request: AppFileListRequest): Promise<AppFileListResult>;
  readFile(request: AppFileReadRequest): Promise<AppFileReadResult>;
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
  sharedStorageService?: SharedStorageService;
  iosSimulatorMediaClient?: IosSimulatorMediaClient;
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
    deps.providers ??
      createDefaultProviders(
        resolvedDeps,
        deps.idGenerator ?? defaultIdGenerator,
        deps.sharedStorageService ?? getSharedStorageService(),
        deps.iosSimulatorMediaClient ??
          new SimctlIosSimulatorMediaClient(resolvedDeps.simctlFactory),
      ),
    resolvedDeps.deviceResolver,
    resolvedDeps.fileSystem,
  );
}

function createDefaultProviders(
  deps: Required<Pick<AppFileServiceDependencies, "adbFactory" | "simctlFactory" | "fileSystem">>,
  idGenerator: IdGenerator = defaultIdGenerator,
  sharedStorageService: SharedStorageService = getSharedStorageService(),
  iosSimulatorMediaClient: IosSimulatorMediaClient = new SimctlIosSimulatorMediaClient(
    deps.simctlFactory,
  ),
): AppFileProvider[] {
  return [
    new AndroidAppFileProvider(deps.adbFactory, idGenerator),
    new AndroidUserFilesProvider(sharedStorageService),
    new AndroidMediaLibraryProvider(sharedStorageService),
    new IosSimulatorAppFileProvider(deps.simctlFactory, deps.fileSystem),
    new IosSimulatorMediaLibraryProvider(iosSimulatorMediaClient, deps.fileSystem),
  ];
}

function providerKey(platform: Platform, domain: StorageDomain): string {
  return `${platform}:${domain}`;
}

function isCanonicalPutRequest(
  request: PutAppFileRequest | LegacyPutAppFileRequest,
): request is PutAppFileRequest {
  return "target" in request && "files" in request;
}

function legacyRequestToCanonical(request: LegacyPutAppFileRequest): PutAppFileRequest {
  const {
    appId,
    container,
    destinationPath,
    sourcePath,
    contentText,
    contentBase64,
    ...deviceArgs
  } = request;
  return {
    ...deviceArgs,
    target: { domain: "app_containers", appId, container },
    files: [{ destinationPath, sourcePath, contentText, contentBase64 }],
  };
}

function normalizeTarget(target: PutAppFileTarget): PutAppFileTarget {
  const normalized = normalizePutAppFileTarget(target);
  if (normalized.domain === "app_containers") {
    return { ...normalized, appId: normalizeAppId(normalized.appId) };
  }
  return normalized;
}

function requireAppContainersTarget(target: PutAppFileTarget): AppContainersTarget {
  if (target.domain !== "app_containers") {
    throw new ActionableError(
      `app-container provider received unsupported target domain: ${target.domain}`,
    );
  }
  return target;
}

function validateDestinationConflicts(files: PutAppFileInput[]): void {
  for (const file of files) {
    if (
      files.some(
        (other) =>
          other !== file &&
          (other.destinationPath === file.destinationPath ||
            other.destinationPath.startsWith(`${file.destinationPath}/`)),
      )
    ) {
      throw new ActionableError(
        `destinationPath conflicts with another file in this request: ${file.destinationPath}`,
      );
    }
  }
}

async function prepareSources(
  files: PutAppFileInput[],
  fileSystem: AppFileFileSystem,
): Promise<Awaited<ReturnType<typeof prepareFileSource>>[]> {
  const prepared: Awaited<ReturnType<typeof prepareFileSource>>[] = [];
  try {
    for (const file of files) {
      prepared.push(await prepareFileSource(file, fileSystem));
    }
    return prepared;
  } catch (error) {
    await Promise.all(prepared.map((source) => source.cleanup?.()));
    throw error;
  }
}

function buildProviderRequests(
  request: PutAppFileRequest | LegacyPutAppFileRequest,
  target: PutAppFileTarget,
  files: PutAppFileInput[],
  prepared: Awaited<ReturnType<typeof prepareFileSource>>[],
): PutAppFileProviderRequest[] {
  return files.map((file, index) => {
    const source = prepared[index]!;
    const providerTarget =
      target.domain === "user_files" && target.reset === true && index > 0
        ? { ...target, reset: false }
        : target;
    return {
      device: request.device,
      target: providerTarget,
      destinationPath: file.destinationPath,
      sourcePath: source.path,
      byteCount: source.byteCount,
      signal: request.signal,
    };
  });
}

async function writeProviderFiles(
  provider: AppFileWriteProvider,
  requests: PutAppFileProviderRequest[],
) {
  if (provider.putFiles) {
    return provider.putFiles(requests);
  }
  return Promise.all(requests.map((request) => provider.putFile(request)));
}

class DefaultAppFileService implements AppFileService {
  private readonly writeProviders = new Map<string, AppFileWriteProvider>();
  private readonly listProviders = new Map<string, AppFileListProvider>();
  private readonly readProviders = new Map<string, AppFileReadProvider>();

  constructor(
    providers: AppFileProvider[],
    private readonly deviceResolver: (deviceId: string) => Promise<BootedDevice>,
    private readonly fileSystem: AppFileFileSystem,
  ) {
    for (const provider of providers) {
      if ("putFile" in provider) {
        this.writeProviders.set(providerKey(provider.platform, provider.domain), provider);
      }
      if ("listFiles" in provider) {
        this.listProviders.set(providerKey(provider.platform, provider.domain), provider);
      }
      if ("readFile" in provider) {
        this.readProviders.set(providerKey(provider.platform, provider.domain), provider);
      }
    }
  }

  async putFile(request: PutAppFileRequest): Promise<PutAppFileBatchResult>;
  async putFile(request: LegacyPutAppFileRequest): Promise<PutAppFileResult>;
  async putFile(
    request: PutAppFileRequest | LegacyPutAppFileRequest,
  ): Promise<PutAppFileBatchResult | PutAppFileResult> {
    const canonicalInput = isCanonicalPutRequest(request);
    const legacy = !canonicalInput || request.legacySingleFile === true;
    const canonical = canonicalInput ? request : legacyRequestToCanonical(request);
    const target = normalizeTarget(canonical.target);
    const files = canonical.files.map((file) => ({
      ...file,
      destinationPath: normalizeAppFileRelativePath(file.destinationPath),
    }));
    validateDestinationConflicts(files);
    const prepared = await prepareSources(files, this.fileSystem);
    try {
      const provider = this.getWriteProvider(request.device.platform, target.domain);
      const providerRequests = buildProviderRequests(request, target, files, prepared);
      const providerResults = await writeProviderFiles(provider, providerRequests);
      const results: PutAppFileWriteResult[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const source = prepared[index]!;
        const providerResult = providerResults[index];
        results.push({
          destinationPath: file.destinationPath,
          byteCount: source.byteCount,
          ...(target.domain === "app_containers"
            ? {
                resourceUri: buildAppFileResourceUri({
                  deviceId: request.device.deviceId,
                  appId: target.appId,
                  container: target.container,
                  path: file.destinationPath,
                }),
              }
            : {}),
          effects: providerResult?.effects ?? [],
        });
      }
      const result: PutAppFileBatchResult = {
        success: true,
        deviceId: request.device.deviceId,
        platform: request.device.platform,
        target,
        files: results,
      };
      if (!legacy) {
        return result;
      }
      const file = results[0]!;
      const appTarget = target as AppContainersTarget;
      return {
        success: true,
        deviceId: result.deviceId,
        platform: result.platform,
        appId: appTarget.appId,
        container: appTarget.container,
        destinationPath: file.destinationPath,
        byteCount: file.byteCount,
        resourceUri: file.resourceUri!,
      };
    } finally {
      await Promise.all(prepared.map((source) => source.cleanup?.()));
    }
  }

  async listFiles(request: AppFileListRequest): Promise<AppFileListResult> {
    const appId = normalizeAppId(request.appId);
    const device = await this.deviceResolver(request.deviceId);
    const provider = this.getListProvider(
      device.platform,
      "app_containers",
      "listFiles",
      appId,
      request.container,
    );
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
    const provider = this.getReadProvider(
      device.platform,
      "app_containers",
      "readFile",
      appId,
      request.container,
    );
    return provider.readFile({
      device,
      deviceId: device.deviceId,
      appId,
      container: request.container,
      path,
    });
  }

  private getWriteProvider(platform: Platform, domain: StorageDomain): AppFileWriteProvider {
    const provider = this.writeProviders.get(providerKey(platform, domain));
    if (!provider) {
      throw new ActionableError(
        `putFile is not supported for ${domain} on ${platform}: no write provider is registered`,
      );
    }
    return provider;
  }

  private getListProvider(
    platform: Platform,
    domain: "app_containers",
    operation: string,
    appId: string,
    container: AppFileContainer,
  ): AppFileListProvider {
    const provider = this.listProviders.get(providerKey(platform, domain));
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

  private getReadProvider(
    platform: Platform,
    domain: "app_containers",
    operation: string,
    appId: string,
    container: AppFileContainer,
  ): AppFileReadProvider {
    const provider = this.readProviders.get(providerKey(platform, domain));
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
}

class AndroidAppFileProvider
  implements AppFileWriteProvider, AppFileListProvider, AppFileReadProvider
{
  readonly platform = "android" as const;
  readonly domain = "app_containers" as const;

  constructor(
    private readonly adbFactory: AdbClientFactory,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<void> {
    const appTarget = requireAppContainersTarget(request.target);
    const adb = this.adbFactory.create(request.device);
    const target = resolveAndroidTarget(
      appTarget.appId,
      appTarget.container,
      request.destinationPath,
    );
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "putFile",
        request.device.platform,
        appTarget.appId,
        appTarget.container,
        target.message,
      );
    }

    if (target.kind === "external") {
      await executeAndroidAppFileCommand(
        adb,
        `shell mkdir -p ${shellQuote(posix.dirname(target.absolutePath))}`,
        {
          device: request.device,
          appId: appTarget.appId,
          container: appTarget.container,
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
          appId: appTarget.appId,
          container: appTarget.container,
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
        appId: appTarget.appId,
        container: appTarget.container,
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
        `shell run-as ${shellQuote(appTarget.appId)} sh -c ${shellQuote(command)}`,
        {
          device: request.device,
          appId: appTarget.appId,
          container: appTarget.container,
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

const ANDROID_MEDIA_LIBRARY_NAMESPACE = "automobile-media";

class AndroidUserFilesProvider implements AppFileWriteProvider {
  readonly platform = "android" as const;
  readonly domain = "user_files" as const;

  constructor(private readonly sharedStorageService: SharedStorageService) {}

  async putFile(request: PutAppFileProviderRequest) {
    return (await this.putFiles([request]))[0];
  }

  async putFiles(requests: PutAppFileProviderRequest[]) {
    if (requests.length === 0) {
      return [];
    }
    const request = requests[0]!;
    if (request.target.domain !== "user_files") {
      throw new ActionableError(
        `Android user-files provider received unsupported target domain: ${request.target.domain}`,
      );
    }
    const result = await this.sharedStorageService.stage({
      device: request.device,
      namespace: request.target.namespace,
      reset: request.target.reset,
      files: requests.map((file) => ({
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
      })),
      signal: request.signal,
    });
    return result.files.map((staged) => ({
      effects: [
        {
          type: "document_picker",
          status: "completed" as const,
          reason:
            `document fixture is available in Downloads for device ${result.deviceId}, ` +
            `resolved profile ${result.userId}, namespace ${result.namespace}`,
        },
        {
          type: "media_index",
          status: staged.mediaIndexing.status,
          ...(staged.mediaIndexing.reason === undefined
            ? {}
            : { reason: staged.mediaIndexing.reason }),
        },
      ],
    }));
  }
}

class AndroidMediaLibraryProvider implements AppFileWriteProvider {
  readonly platform = "android" as const;
  readonly domain = "media_library" as const;

  constructor(private readonly sharedStorageService: SharedStorageService) {}

  async putFile(request: PutAppFileProviderRequest) {
    return (await this.putFiles([request]))[0];
  }

  async putFiles(requests: PutAppFileProviderRequest[]) {
    if (requests.length === 0) {
      return [];
    }
    const request = requests[0]!;
    if (request.target.domain !== "media_library") {
      throw new ActionableError(
        `Android media-library provider received unsupported target domain: ${request.target.domain}`,
      );
    }
    const result = await this.sharedStorageService.stage({
      device: request.device,
      namespace: ANDROID_MEDIA_LIBRARY_NAMESPACE,
      files: requests.map((file) => ({
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
      })),
      signal: request.signal,
    });
    return result.files.map((staged) => {
      if (staged.mediaIndexing.status !== "completed") {
        throw new ActionableError(
          `Android media-library fixture ${staged.destinationPath} on device ${result.deviceId}, ` +
            `resolved profile ${result.userId}, was not indexed. ` +
            "Recovery: use an image, video, or audio filename supported by Android MediaStore.",
        );
      }
      return {
        effects: [
          {
            type: "media_index",
            status: "completed" as const,
            reason:
              `MediaStore verified fixture discovery for device ${result.deviceId}, ` +
              `resolved profile ${result.userId}, namespace ${result.namespace}`,
          },
        ],
      };
    });
  }
}

class IosSimulatorMediaLibraryProvider implements AppFileWriteProvider {
  readonly platform = "ios" as const;
  readonly domain = "media_library" as const;

  constructor(
    private readonly mediaClient: IosSimulatorMediaClient,
    private readonly fileSystem: AppFileFileSystem,
  ) {}

  async putFile(request: PutAppFileProviderRequest) {
    return (await this.putFiles([request]))[0];
  }

  async putFiles(requests: PutAppFileProviderRequest[]) {
    if (requests.length === 0) {
      return [];
    }
    const request = requests[0]!;
    if (!isIosSimulatorUdid(request.device.deviceId)) {
      throw new ActionableError(
        `iOS media-library staging is only supported on iOS simulators. Device ${request.device.deviceId} looks like a physical iOS device.`,
      );
    }
    for (const file of requests) {
      if (!hasSupportedSimulatorMediaExtension(file.destinationPath)) {
        throw new ActionableError(
          `iOS Simulator media fixture requires a supported image or video extension: ${file.destinationPath}`,
        );
      }
    }
    const directory = await this.fileSystem.mkdtemp(join(tmpdir(), "automobile-ios-media-"));
    try {
      const paths = await Promise.all(
        requests.map(async (file, index) => {
          // Keep the requested filename for media-type inference while isolating
          // duplicate basenames from separate destination directories.
          const path = join(directory, String(index), basename(file.destinationPath));
          await this.fileSystem.mkdir(dirname(path));
          await this.fileSystem.copyFile(file.sourcePath, path);
          return path;
        }),
      );
      await this.mediaClient.importMedia(request.device, paths, request.signal);
      return requests.map(() => ({
        effects: [
          {
            type: "media_import",
            status: "completed" as const,
            reason: "Imported into the iOS Simulator media library through simctl addmedia.",
          },
          {
            type: "picker_visibility",
            status: "unavailable" as const,
            reason: "Picker visibility is not verified by simctl addmedia.",
          },
        ],
      }));
    } finally {
      await this.fileSystem.rm(directory);
    }
  }
}

class IosSimulatorAppFileProvider
  implements AppFileWriteProvider, AppFileListProvider, AppFileReadProvider
{
  readonly platform = "ios" as const;
  readonly domain = "app_containers" as const;

  constructor(
    private readonly simctlFactory: (device: BootedDevice) => SimCtlClient,
    private readonly fileSystem: AppFileFileSystem,
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<void> {
    const appTarget = requireAppContainersTarget(request.target);
    const target = await this.resolvePath(
      request.device,
      appTarget.appId,
      appTarget.container,
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
