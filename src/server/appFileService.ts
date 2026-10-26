import type { SimulatorContainerOwnershipOptions } from "../utils/ios-cmdline-tools/simulatorOwnContainer";
import {
  DefaultDeviceServicePreflight,
  type DeviceServicePreflight,
} from "../utils/deviceServicePreflight";
import type { AppFileProviderCoverage } from "../features/storage/storageCapabilities";
import { setDefaultAppFileProviderCoverageSource } from "../features/storage/defaultAppFileProviderCoverage";
import {
  AppContainersTarget,
  AppFileContainer,
  AppFileListRequest,
  AppFileListResult,
  AppFileReadRequest,
  AppFileReadResult,
  LegacyPutAppFileInput,
  PutAppFileArgs,
  PutAppFileBatchResult,
  PutAppFileInput,
  PutAppFileResult,
  PutAppFileTarget,
  PutAppFileWriteResult,
  StorageDomain,
  buildAppFileResourceUri,
  normalizeAppFileRelativePath,
  normalizePutAppFileTarget,
} from "./appFileContract";
import { ActionableError, BootedDevice, Platform } from "../models";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { getSharedStorageService, type SharedStorageService } from "./sharedStorageService";
import {
  SimctlIosSimulatorMediaClient,
  type IosSimulatorMediaClient,
} from "./iosSimulatorMediaClient";
import {
  IosSimulatorUserFilesProvider,
  validateIosFilesDeviceTarget,
  type DocumentPickerVisibilityVerifier,
  type IosFilesFixtureContainer,
} from "./IosSimulatorUserFilesProvider";
import {
  getIosFilesFixtureInstaller,
  type IosFilesFixtureInstaller,
} from "./IosFilesFixtureInstaller";
import {
  batchWarning,
  findBootedDevice,
  nodeAppFileFileSystem,
  normalizeAppId,
  unsupportedAppFileOperation,
} from "./appFileSupport";
import { AndroidAppFileProvider } from "./AndroidAppFileProvider";
import { AndroidUserFilesProvider } from "./AndroidUserFilesProvider";
import { AndroidMediaLibraryProvider } from "./AndroidMediaLibraryProvider";
import { IosSimulatorAppFileProvider } from "./IosSimulatorAppFileProvider";
import { SimctlIosFilesFixtureContainer } from "./SimctlIosFilesFixtureContainer";
import { IosSimulatorMediaLibraryProvider } from "./IosSimulatorMediaLibraryProvider";
import { prepareFileSource } from "./fileSourcePreparation";

export { APP_FILE_PUSH_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";

export type PutAppFileRequest = Omit<PutAppFileArgs, "device" | "target"> & {
  device: BootedDevice;
  /** Callers may omit `indexMedia`; the service defaults it to false. */
  target: PutAppFileTarget;
  signal?: AbortSignal;
};

export type LegacyPutAppFileRequest = Omit<LegacyPutAppFileInput, "device"> & {
  device: BootedDevice;
  signal?: AbortSignal;
};

export interface PutAppFileProviderRequest {
  device: BootedDevice;
  userId?: number;
  target: PutAppFileTarget;
  destinationPath: string;
  sourcePath: string;
  byteCount: number;
  signal?: AbortSignal;
}

export interface AppFileProviderListRequest extends AppFileListRequest {
  device: BootedDevice;
  userId?: number;
}

export interface AppFileProviderReadRequest extends AppFileReadRequest {
  device: BootedDevice;
  path: string;
  userId?: number;
}

export type { AppFileProviderCoverage };

export interface AppFileProviderCoverageReader {
  describeProviderCoverage(): readonly AppFileProviderCoverage[];
}

export interface AppFileWriteProvider {
  readonly platform: Platform;
  readonly domain: StorageDomain;
  readonly features?: Readonly<{ namespaceReset?: boolean; mediaIndexing?: boolean }>;
  putFile(request: PutAppFileProviderRequest): Promise<void | AppFileProviderWriteResult>;
  /**
   * Optional batch path for providers whose device operation must use one
   * consistent target (for example, a single Android user profile).
   */
  putFiles?(
    requests: PutAppFileProviderRequest[],
  ): Promise<Array<void | AppFileProviderWriteResult>>;
}

export interface AppFileProviderWriteResult {
  appRunning?: boolean;
  effects?: PutAppFileWriteResult["effects"];
  resourceUserId?: number;
  /** Non-fatal note for the caller, e.g. backups that could not be cleaned up. */
  warning?: string;
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
  describeProviderCoverage?(): readonly AppFileProviderCoverage[];
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
  rename(oldPath: string, newPath: string): Promise<void>;
  readFileBuffer(path: string): Promise<Buffer>;
  writeFileBuffer(path: string, data: Buffer): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
}

export interface ForegroundAppLookup {
  getForegroundApp(signal?: AbortSignal): Promise<{ packageName: string; userId: number } | null>;
}

/** The simctl operations app file transfers use. */
export type AppFileSimCtl = Pick<SimCtlClient, "executeCommand" | "executeCommandArgs">;

export interface AppFileServiceDependencies {
  containerOwnership?: SimulatorContainerOwnershipOptions;
  servicePreflight?: DeviceServicePreflight;
  timer?: Timer;
  foregroundAppLookup?: ForegroundAppLookup;
  adbFactory?: AdbClientFactory;
  simctlFactory?: (device: BootedDevice) => AppFileSimCtl;
  fileSystem?: AppFileFileSystem;
  providers?: AppFileProvider[];
  deviceResolver?: (deviceId: string) => Promise<BootedDevice>;
  idGenerator?: IdGenerator;
  sharedStorageService?: SharedStorageService;
  iosSimulatorMediaClient?: IosSimulatorMediaClient;
  iosFilesFixtureContainer?: IosFilesFixtureContainer;
  /** Production wires the swiftc-backed installer; tests stay hermetic unless they inject one. */
  iosFilesFixtureInstaller?: IosFilesFixtureInstaller;
  documentPickerVisibilityVerifier?: DocumentPickerVisibilityVerifier;
}

const defaultDependencies: Required<
  Pick<AppFileServiceDependencies, "adbFactory" | "simctlFactory" | "fileSystem" | "deviceResolver">
> = {
  adbFactory: defaultAdbClientFactory,
  simctlFactory: (device) => new SimCtlClient(device),
  fileSystem: nodeAppFileFileSystem,
  deviceResolver: findBootedDevice,
};

let appFileService: AppFileService | null = null;

export function getAppFileService(): AppFileService {
  if (!appFileService) {
    appFileService = new DefaultAppFileService(
      createDefaultProviders(defaultDependencies, {
        iosFilesFixtureInstaller: getIosFilesFixtureInstaller(),
      }),
      defaultDependencies.deviceResolver,
      defaultDependencies.fileSystem,
    );
  }
  return appFileService;
}

export function createAppFileServiceForTesting(
  deps: AppFileServiceDependencies = {},
): AppFileService {
  const resolvedDeps = {
    timer: deps.timer ?? defaultTimer,
    adbFactory: deps.adbFactory ?? defaultDependencies.adbFactory,
    simctlFactory: deps.simctlFactory ?? defaultDependencies.simctlFactory,
    fileSystem: deps.fileSystem ?? defaultDependencies.fileSystem,
    deviceResolver: deps.deviceResolver ?? defaultDependencies.deviceResolver,
  };
  return new DefaultAppFileService(
    deps.providers ??
      createDefaultProviders(resolvedDeps, {
        ...deps,
        // Hermetic by default: tests inject a fake preflight to exercise the check.
        servicePreflight: deps.servicePreflight ?? { assertEnabled: async () => {} },
        sharedStorageService: deps.sharedStorageService ?? getSharedStorageService(),
      }),
    resolvedDeps.deviceResolver,
    resolvedDeps.fileSystem,
  );
}

function createDefaultProviders(
  deps: Required<Pick<AppFileServiceDependencies, "adbFactory" | "simctlFactory" | "fileSystem">> &
    Pick<AppFileServiceDependencies, "timer">,
  options: Pick<
    AppFileServiceDependencies,
    | "containerOwnership"
    | "servicePreflight"
    | "idGenerator"
    | "sharedStorageService"
    | "iosSimulatorMediaClient"
    | "foregroundAppLookup"
    | "iosFilesFixtureContainer"
    | "iosFilesFixtureInstaller"
    | "documentPickerVisibilityVerifier"
  > = {},
): AppFileProvider[] {
  return [
    new AndroidAppFileProvider(deps.adbFactory, {
      idGenerator: options.idGenerator ?? defaultIdGenerator,
      foregroundAppLookup: options.foregroundAppLookup,
      timer: deps.timer,
    }),
    new AndroidUserFilesProvider(options.sharedStorageService),
    new AndroidMediaLibraryProvider(options.sharedStorageService),
    new IosSimulatorAppFileProvider(
      deps.simctlFactory,
      deps.fileSystem,
      options.containerOwnership,
    ),
    new IosSimulatorUserFilesProvider(
      options.iosFilesFixtureContainer ??
        new SimctlIosFilesFixtureContainer(
          deps.simctlFactory,
          deps.fileSystem,
          options.containerOwnership,
        ),
      options.documentPickerVisibilityVerifier,
      options.iosFilesFixtureInstaller,
    ),
    new IosSimulatorMediaLibraryProvider(
      options.iosSimulatorMediaClient ?? new SimctlIosSimulatorMediaClient(deps.simctlFactory),
      deps.fileSystem,
      options.servicePreflight ?? new DefaultDeviceServicePreflight(),
    ),
  ];
}

/** Pure coverage view; last registration wins independently for each operation, like routing. */
export function describeProviderCoverage(
  providers: readonly AppFileProvider[],
): AppFileProviderCoverage[] {
  const coverage = new Map<string, AppFileProviderCoverage>();
  for (const provider of providers) {
    const key = providerKey(provider.platform, provider.domain);
    const previous = coverage.get(key) ?? {
      platform: provider.platform,
      domain: provider.domain,
      write: false,
      list: false,
      read: false,
      namespaceReset: false,
      mediaIndexing: false,
    };
    coverage.set(key, {
      ...previous,
      ...("putFile" in provider
        ? {
            write: true,
            namespaceReset: provider.features?.namespaceReset === true,
            mediaIndexing: provider.features?.mediaIndexing === true,
          }
        : {}),
      ...("listFiles" in provider ? { list: true } : {}),
      ...("readFile" in provider ? { read: true } : {}),
    });
  }
  return [...coverage.values()];
}

/** Metadata only: constructing production providers does not perform device or filesystem I/O. */
export function describeDefaultAppFileProviderCoverage(): readonly AppFileProviderCoverage[] {
  return describeProviderCoverage(createDefaultProviders(defaultDependencies));
}
setDefaultAppFileProviderCoverageSource(describeDefaultAppFileProviderCoverage);

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
      userId: request.userId,
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

  describeProviderCoverage(): readonly AppFileProviderCoverage[] {
    return describeProviderCoverage([
      ...this.listProviders.values(),
      ...this.readProviders.values(),
      ...this.writeProviders.values(),
    ]);
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
    // Reject before even preparing a host source for an unsupported device.
    validateIosFilesDeviceTarget(request.device, target);
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
                  userId: providerResult?.resourceUserId,
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
        ...batchWarning([
          target.domain === "app_containers" &&
          providerResults.some((entry) => entry?.appRunning === true)
            ? `App ${target.appId} is running and may not see the change until it re-reads the file or is relaunched.`
            : undefined,
          ...providerResults.map((entry) => entry?.warning),
        ]),
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
        ...(result.warning ? { warning: result.warning } : {}),
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
      userId: request.userId,
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
      userId: request.userId,
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
