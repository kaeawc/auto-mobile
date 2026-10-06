import { APP_FILE_PUSH_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
import { runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { errorMessage } from "../utils/describeUnknownError";
import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
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
  UserFilesTarget,
  buildAppFileResourceUri,
  hasSupportedMediaLibraryExtension,
  hasSupportedSimulatorMediaExtension,
  normalizeAppFileRelativePath,
  normalizeUserFilesNamespace,
  normalizePutAppFileTarget,
} from "./appFileContract";
import {
  ActionableError,
  toActionableError,
  BootedDevice,
  Platform,
  type ExecResult,
} from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { shellQuote } from "../utils/shellQuote";
import { isPackageInstalledForUser } from "../utils/android-cmdline-tools/isPackageInstalledForUser";
import { AndroidUserTargetResolver } from "../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { logger } from "../utils/logger";
import { prepareFileSource } from "./fileSourcePreparation";
import {
  getSharedStorageService,
  rollbackWrittenFiles,
  type SharedStorageService,
} from "./sharedStorageService";
import {
  SimctlIosSimulatorMediaClient,
  type IosSimulatorMediaClient,
} from "./iosSimulatorMediaClient";
import { findIosSimulatorAppProcess } from "../features/action/CrashApp";
import { readAndroidPackageProcesses } from "../utils/android-cmdline-tools/androidProcessState";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { findBootedDeviceForResource } from "./resourceDeviceResolver";
import { androidRollbackScript, androidSaveBackupScript } from "./androidFileBackup";

export { APP_FILE_PUSH_TIMEOUT_MS } from "../features/storage/fileTransferTimeout";
const APP_FILE_STAGING_CLEANUP_COMMAND_TIMEOUT_MS = 5000;
/** Printed by the write script only when it saved the previous content of an overwritten file. */
const APP_FILE_BACKUP_MARKER = "AUTOMOBILE_APP_FILE_BACKUP";

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

export interface AppFileProviderCoverage {
  readonly platform: Platform;
  readonly domain: StorageDomain;
  readonly write: boolean;
  readonly list: boolean;
  readonly read: boolean;
  readonly namespaceReset: boolean;
  readonly mediaIndexing: boolean;
}

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

interface AppFileProviderWriteResult {
  appRunning?: boolean;
  effects?: PutAppFileWriteResult["effects"];
  resourceUserId?: number;
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

export interface AppFileServiceDependencies {
  timer?: Timer;
  foregroundAppLookup?: ForegroundAppLookup;
  adbFactory?: AdbClientFactory;
  simctlFactory?: (device: BootedDevice) => SimCtlClient;
  fileSystem?: AppFileFileSystem;
  providers?: AppFileProvider[];
  deviceResolver?: (deviceId: string) => Promise<BootedDevice>;
  idGenerator?: IdGenerator;
  sharedStorageService?: SharedStorageService;
  iosSimulatorMediaClient?: IosSimulatorMediaClient;
  iosFilesFixtureContainer?: IosFilesFixtureContainer;
  documentPickerVisibilityVerifier?: DocumentPickerVisibilityVerifier;
}

export const nodeAppFileFileSystem: AppFileFileSystem = {
  stat: async (path) => nodeFs.stat(path),
  lstat: async (path) => nodeFs.lstat(path),
  readdir: async (path) => nodeFs.readdir(path, { withFileTypes: true }),
  mkdir: async (path) => {
    await nodeFs.mkdir(path, { recursive: true });
  },
  copyFile: async (sourcePath, destinationPath) => {
    await nodeFs.copyFile(sourcePath, destinationPath);
  },
  rename: async (oldPath, newPath) => {
    await nodeFs.rename(oldPath, newPath);
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
    | "idGenerator"
    | "sharedStorageService"
    | "iosSimulatorMediaClient"
    | "foregroundAppLookup"
    | "iosFilesFixtureContainer"
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
    new IosSimulatorAppFileProvider(deps.simctlFactory, deps.fileSystem),
    new IosSimulatorUserFilesProvider(
      options.iosFilesFixtureContainer ??
        new SimctlIosFilesFixtureContainer(deps.simctlFactory, deps.fileSystem),
      options.documentPickerVisibilityVerifier,
    ),
    new IosSimulatorMediaLibraryProvider(
      options.iosSimulatorMediaClient ?? new SimctlIosSimulatorMediaClient(deps.simctlFactory),
      deps.fileSystem,
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
        ...(target.domain === "app_containers" &&
        providerResults.some((entry) => entry?.appRunning === true)
          ? {
              warning: `App ${target.appId} is running and may not see the change until it re-reads the file or is relaunched.`,
            }
          : {}),
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

interface AndroidAppFileUser {
  userId: number;
  pinInResourceUri: boolean;
}

// Explicit IDs (including 0) always round-trip. Auto-resolved 0 is pinned only
// when several users have the app installed; a sole user-0 installation keeps
// its existing query-free URI. Nonzero resolved users are always pinned.
async function resolveAndroidAppFileUser(
  adb: AdbExecutor,
  foregroundAppLookup: ForegroundAppLookup,
  device: BootedDevice,
  appId: string,
  userId?: number,
  signal?: AbortSignal,
): Promise<AndroidAppFileUser> {
  const resolver = new AndroidUserTargetResolver(adb);
  if (userId !== undefined) {
    if (!Number.isSafeInteger(userId) || userId < 0) {
      throw new ActionableError("Android userId must be a non-negative safe integer.");
    }
    return {
      userId: (await resolver.resolve({ explicitUserId: userId, signal })).userId,
      pinInResourceUri: true,
    };
  }

  try {
    // Once per operation/batch: listUsers + one pm list per user. A user-0-only
    // device needs just those two reads; foreground/current probes are only for ambiguity.
    const users = await adb.listUsers(signal);
    if (users.length === 0) {
      throw new ActionableError(
        `Android user resolution failed for ${appId} on ${device.deviceId}: no users could be determined. Pass userId explicitly (resource query ?userId=N).`,
      );
    }
    let candidates: number[] = [];
    for (const user of users) {
      if (await isPackageInstalledForUser(adb, appId, user.userId, undefined, signal)) {
        candidates.push(user.userId);
      }
    }
    const runningCandidates = users
      .filter((user) => user.running && candidates.includes(user.userId))
      .map((user) => user.userId);
    if (runningCandidates.length > 0) {
      candidates = runningCandidates;
    }
    // With no running candidates, preserve selection: run-as behavior for stopped
    // users is unverified and needs a device capture.
    if (candidates.length === 1) {
      return { userId: candidates[0]!, pinInResourceUri: candidates[0] !== 0 };
    }
    if (candidates.length === 0) {
      throw new ActionableError(
        `Android app ${appId} is not installed for any user on ${device.deviceId}. Install the app for the intended user.`,
      );
    }
    return await resolveAmbiguousAndroidAppFileUser(
      adb,
      foregroundAppLookup,
      device,
      appId,
      candidates,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    throw toActionableError(
      error,
      `Android user resolution failed for ${appId} on ${device.deviceId}. Pass userId explicitly (resource query ?userId=N)`,
    );
  }
}

async function resolveAmbiguousAndroidAppFileUser(
  adb: AdbExecutor,
  foregroundAppLookup: ForegroundAppLookup,
  device: BootedDevice,
  appId: string,
  candidates: number[],
  signal?: AbortSignal,
): Promise<AndroidAppFileUser> {
  try {
    const foreground = await foregroundAppLookup.getForegroundApp(signal);
    if (foreground?.packageName === appId && candidates.includes(foreground.userId)) {
      return { userId: foreground.userId, pinInResourceUri: true };
    }
  } catch (error) {
    signal?.throwIfAborted();
    // Foreground lookup is an optional refinement; current-user resolution remains available.
    logger.debug("Android app-file foreground lookup failed", error);
  }
  const current = await new AndroidUserTargetResolver(adb).resolve({ currentUser: true, signal });
  if (current.source === "currentUser" && candidates.includes(current.userId)) {
    return { userId: current.userId, pinInResourceUri: true };
  }
  throw new ActionableError(
    `Android app ${appId} on ${device.deviceId} is installed for candidate users ${candidates.join(", ")}, but no installed foreground user could be selected. Pass userId explicitly (resource query ?userId=N).`,
  );
}

function androidRunAsPrefix(appId: string, userId: number): string {
  // AOSP run-as grammar: usage: run-as <package-name> [--user <uid>] <command> [<args>] (system/core/run-as/run-as.cpp), so --user follows the package name.
  return `shell run-as ${shellQuote(appId)}${userId ? ` --user ${userId}` : ""}`;
}

function androidAppFilePrefix(appTarget: AppContainersTarget, userId: number): string {
  return appTarget.container === "externalFiles"
    ? "shell"
    : androidRunAsPrefix(appTarget.appId, userId);
}

class AndroidAppFileProvider
  implements AppFileWriteProvider, AppFileListProvider, AppFileReadProvider
{
  readonly platform = "android" as const;
  readonly domain = "app_containers" as const;
  private readonly idGenerator: IdGenerator;
  private readonly foregroundAppLookup?: ForegroundAppLookup;
  private readonly timer: Timer;

  constructor(
    private readonly adbFactory: AdbClientFactory,
    options: Pick<AppFileServiceDependencies, "idGenerator" | "foregroundAppLookup" | "timer"> = {},
  ) {
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.foregroundAppLookup = options.foregroundAppLookup;
    this.timer = options.timer ?? defaultTimer;
  }

  async putFile(request: PutAppFileProviderRequest): Promise<AppFileProviderWriteResult> {
    return (await this.putFiles([request]))[0]!;
  }

  async putFiles(requests: PutAppFileProviderRequest[]): Promise<AppFileProviderWriteResult[]> {
    if (requests.length === 0) {
      return [];
    }
    const request = requests[0]!;
    const appTarget = requireAppContainersTarget(request.target);
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
    const adb = this.adbFactory.create(request.device);
    const { userId, pinInResourceUri } = await resolveAndroidAppFileUser(
      adb,
      this.foregroundAppLookup ?? adb,
      request.device,
      appTarget.appId,
      request.userId,
      request.signal,
    );
    const results: AppFileProviderWriteResult[] = [];
    const writtenPaths: string[] = [];
    // Destinations this batch overwrote, keyed to the backup of their previous content.
    const backups = new Map<string, string>();
    const cleanupFailures: string[] = [];
    let failedPath = request.destinationPath;
    try {
      for (const file of requests) {
        failedPath = file.destinationPath;
        await this.writeFile(
          file,
          adb,
          userId,
          (backup) => {
            writtenPaths.push(file.destinationPath);
            if (backup !== undefined) {
              backups.set(file.destinationPath, backup);
            }
          },
          cleanupFailures,
          // A single-file write has no earlier file to roll back, so it needs no backup.
          requests.length > 1,
        );
        if (cleanupFailures.length > 0) {
          throw new ActionableError("Android app-file staging cleanup failed.");
        }
        results.push({ resourceUserId: pinInResourceUri ? userId : undefined });
      }
    } catch (error) {
      const rollback = await this.rollbackFiles(adb, appTarget, userId, writtenPaths, backups);
      throw new ActionableError(
        `Android app-container batch staging failed for ${failedPath}: ${errorMessage(error)} ` +
          `Rolled back: ${rollback.rolledBack.length > 0 ? rollback.rolledBack.join(", ") : "none"}. ` +
          `Rollback failures: ${[...rollback.failures, ...cleanupFailures].join("; ") || "none"}.`,
        { cause: error },
      );
    }
    await this.discardBackups(adb, appTarget, userId, [...backups.values()]);
    await this.confirmRunningState(adb, request, appTarget, userId, results);
    return results;
  }

  /** The whole batch committed, so the saved previous contents are no longer needed. */
  private async discardBackups(
    adb: AdbExecutor,
    appTarget: AppContainersTarget,
    userId: number,
    backups: string[],
  ): Promise<void> {
    if (backups.length === 0) {
      return;
    }
    const failures: string[] = [];
    const prefix = androidAppFilePrefix(appTarget, userId);
    await this.cleanupStaging(
      adb,
      [`${prefix} rm -f ${backups.map(shellQuote).join(" ")}`],
      "previous-content backups",
      failures,
    );
    if (failures.length > 0) {
      // The write already succeeded; stray hidden backups must not fail it.
      logger.warn(`Left Android app-file backups behind: ${failures.join("; ")}`);
    }
  }

  private async confirmRunningState(
    adb: AdbExecutor,
    request: PutAppFileProviderRequest,
    appTarget: AppContainersTarget,
    userId: number,
    results: AppFileProviderWriteResult[],
  ): Promise<void> {
    try {
      const state = await readAndroidPackageProcesses(adb, appTarget.appId, {
        userId,
        signal: request.signal,
        timer: this.timer,
      });
      if (state.isRunning) {
        for (const result of results) {
          result.appRunning = true;
        }
      } else if (
        state.processes.length === 0 &&
        !state.stdout.includes("ACTIVITY MANAGER RUNNING PROCESSES")
      ) {
        logger.warn(
          `Unable to read Android running state for ${appTarget.appId}: unparseable process output`,
        );
      }
    } catch (error) {
      // Running-state confirmation is best effort after the entire write has succeeded.
      logger.warn(
        `Failed to check Android running state for ${appTarget.appId}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private rollbackFiles(
    adb: AdbExecutor,
    appTarget: AppContainersTarget,
    userId: number,
    writtenPaths: string[],
    backups: ReadonlyMap<string, string>,
  ) {
    return rollbackWrittenFiles(writtenPaths, this.timer, (paths, signal, timeoutMs) => {
      const created: string[] = [];
      const restores: string[] = [];
      for (const path of paths) {
        const resolved = resolveAndroidTarget(appTarget.appId, appTarget.container, path, userId);
        if (resolved.kind === "unsupported") {
          throw new ActionableError(resolved.message);
        }
        const destination = shellQuote(
          resolved.kind === "external" ? resolved.absolutePath : resolved.relativePath,
        );
        const backup = backups.get(path);
        if (backup === undefined) {
          created.push(destination);
        } else {
          restores.push(`mv -f ${shellQuote(backup)} ${destination}`);
        }
      }
      const prefix = androidAppFilePrefix(appTarget, userId);
      // Only destinations this batch created are deleted; overwritten ones get their content back.
      const command =
        restores.length === 0
          ? `${prefix} rm -f ${created.join(" ")}`
          : `${prefix} sh -c ${shellQuote(androidRollbackScript(created, restores))}`;
      return adb.executeCommand(command, timeoutMs, undefined, true, signal, true);
    });
  }

  private async writeFile(
    request: PutAppFileProviderRequest,
    adb: AdbExecutor,
    userId: number,
    onWritten: (backup: string | undefined) => void,
    cleanupFailures: string[],
    keepPrevious: boolean,
  ): Promise<void> {
    const appTarget = requireAppContainersTarget(request.target);
    const target = resolveAndroidTarget(
      appTarget.appId,
      appTarget.container,
      request.destinationPath,
      userId,
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
    const prefix =
      target.kind === "external" ? "shell" : androidRunAsPrefix(appTarget.appId, userId);
    const destination = target.kind === "external" ? target.absolutePath : target.relativePath;
    const token = this.idGenerator.next();
    const temporary = posix.join(posix.dirname(destination), `.automobile-${token}.tmp`);
    const backup = posix.join(posix.dirname(destination), `.automobile-${token}.bak`);
    const staging =
      target.kind === "external"
        ? temporary
        : `/data/local/tmp/automobile-${token}-${posix.basename(request.destinationPath)}`;
    const context = {
      device: request.device,
      appId: appTarget.appId,
      container: appTarget.container,
      operation: "write" as const,
      userId,
      access: target.kind === "external" ? ("externalFiles" as const) : ("run-as" as const),
    };
    // Save the previous content before it is replaced so a failed batch can restore it.
    const saveBackup = keepPrevious
      ? `${androidSaveBackupScript(destination, backup, APP_FILE_BACKUP_MARKER)} && `
      : "";
    const cleanupCommands = [
      ...(target.kind === "external" ? [] : [`shell rm -f ${shellQuote(staging)}`]),
      `${prefix} rm -f ${shellQuote(temporary)}`,
    ];
    let restoreOnFailure = keepPrevious;
    try {
      if (target.kind === "external") {
        await executeAndroidAppFileCommand(
          adb,
          `shell mkdir -p ${shellQuote(posix.dirname(destination))}`,
          context,
          { noRetry: true, signal: request.signal },
        );
      }
      await executeAndroidAppFileCommand(
        adb,
        `push ${shellQuote(request.sourcePath)} ${shellQuote(staging)}`,
        context,
        { noRetry: true, signal: request.signal, timeoutMs: APP_FILE_PUSH_TIMEOUT_MS },
      );
      const replace = `mv -f ${shellQuote(temporary)} ${shellQuote(destination)}`;
      const command =
        target.kind === "external"
          ? `${saveBackup}${replace}`
          : `mkdir -p ${shellQuote(posix.dirname(destination))} && ` +
            `cp ${shellQuote(staging)} ${shellQuote(temporary)} && ` +
            `chmod 600 ${shellQuote(temporary)} && ${saveBackup}${replace}`;
      const output = await executeAndroidAppFileCommand(
        adb,
        `${prefix} sh -c ${shellQuote(command)}`,
        context,
        { noRetry: true, signal: request.signal },
      );
      restoreOnFailure = false;
      onWritten(output.stdout.includes(APP_FILE_BACKUP_MARKER) ? backup : undefined);
    } finally {
      if (restoreOnFailure) {
        // An ambiguous failure (e.g. a deadline after the rename) must not strand the original
        // content in the backup; restoring is a no-op when the destination was never replaced.
        cleanupCommands.push(
          `${prefix} sh -c ${shellQuote(
            `if [ -f ${shellQuote(backup)} ]; then mv -f ${shellQuote(backup)} ${shellQuote(destination)}; fi`,
          )}`,
        );
      }
      await this.cleanupStaging(adb, cleanupCommands, request.destinationPath, cleanupFailures);
    }
  }

  private async cleanupStaging(
    adb: AdbExecutor,
    commands: string[],
    destinationPath: string,
    failures: string[],
  ): Promise<void> {
    // Cleanup must outlive both explicit and ambient request cancellation.
    for (const command of commands) {
      const cleanup = new AbortController();
      try {
        await runWithAbortSignal(undefined, () =>
          raceWithDeadline(
            () =>
              adb.executeCommand(
                command,
                APP_FILE_STAGING_CLEANUP_COMMAND_TIMEOUT_MS,
                undefined,
                true,
                cleanup.signal,
                true,
              ),
            {
              timer: this.timer,
              timeoutMs: APP_FILE_STAGING_CLEANUP_COMMAND_TIMEOUT_MS,
              label: "Android app-file staging cleanup",
              onTimeout: () => cleanup.abort(),
            },
          ),
        );
      } catch (error) {
        failures.push(`${destinationPath} staging cleanup (${command}): ${errorMessage(error)}`);
        logger.warn("Android app-file staging cleanup failed", error);
      }
    }
  }

  async listFiles(request: AppFileProviderListRequest): Promise<AppFileListResult> {
    const adb = this.adbFactory.create(request.device);
    let base = resolveAndroidTarget(request.appId, request.container, "placeholder");
    if (base.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "listFiles",
        request.device.platform,
        request.appId,
        request.container,
        base.message,
      );
    }

    const { userId, pinInResourceUri } = await resolveAndroidAppFileUser(
      adb,
      this.foregroundAppLookup ?? adb,
      request.device,
      request.appId,
      request.userId,
    );
    if (base.kind === "external" && userId !== 0) {
      const resolved = resolveAndroidTarget(
        request.appId,
        request.container,
        "placeholder",
        userId,
      );
      if (resolved.kind === "external") {
        base = resolved;
      }
    }

    const root =
      base.kind === "external"
        ? posix.dirname(base.absolutePath)
        : posix.dirname(base.relativePath);
    const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -exec stat -c '%F|%s|%Y|%n' {} \\; ; fi`;
    const runAs = base.kind === "external" ? undefined : androidRunAsPrefix(request.appId, userId);
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
                userId,
                access: "externalFiles",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
            )
          ).stdout
        : (
            await executeAndroidAppFileCommand(
              adb,
              `${runAs} sh -c ${shellQuote(script)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "list",
                userId,
                access: "run-as",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
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
      files: files.map((file) => ({
        ...file,
        resourceUri: buildAppFileResourceUri({
          deviceId: request.device.deviceId,
          appId: request.appId,
          container: request.container,
          path: file.path,
          userId: pinInResourceUri ? userId : undefined,
        }),
      })),
    };
  }

  async readFile(request: AppFileProviderReadRequest): Promise<AppFileReadResult> {
    const adb = this.adbFactory.create(request.device);
    let target = resolveAndroidTarget(request.appId, request.container, request.path);
    if (target.kind === "unsupported") {
      throw unsupportedAppFileOperation(
        "readFile",
        request.device.platform,
        request.appId,
        request.container,
        target.message,
      );
    }

    const { userId } = await resolveAndroidAppFileUser(
      adb,
      this.foregroundAppLookup ?? adb,
      request.device,
      request.appId,
      request.userId,
    );
    if (target.kind === "external" && userId !== 0) {
      const resolved = resolveAndroidTarget(request.appId, request.container, request.path, userId);
      if (resolved.kind === "external") {
        target = resolved;
      }
    }

    const runAs =
      target.kind === "external" ? undefined : androidRunAsPrefix(request.appId, userId);
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
                userId,
                access: "externalFiles",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
            )
          ).stdout
        : (
            await executeAndroidAppFileCommand(
              adb,
              `${runAs} base64 ${shellQuote(target.relativePath)}`,
              {
                device: request.device,
                appId: request.appId,
                container: request.container,
                operation: "read",
                userId,
                access: "run-as",
              },
              {
                maxBuffer: ANDROID_APP_FILE_MAX_BUFFER,
                noRetry: true,
                timeoutMs: APP_FILE_PUSH_TIMEOUT_MS,
              },
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
  readonly features = { namespaceReset: true, mediaIndexing: true } as const;

  // Resolve the shared service only for a write; metadata queries remain pure.
  constructor(private readonly sharedStorageService?: SharedStorageService) {}

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
    const result = await (this.sharedStorageService ?? getSharedStorageService()).stage({
      device: request.device,
      ...(request.userId === undefined ? {} : { explicitUserId: request.userId }),
      namespace: request.target.namespace,
      reset: request.target.reset,
      indexMedia: request.target.indexMedia ?? false,
      files: requests.map((file) => ({
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
      })),
      signal: request.signal,
      rollbackOnFailure: true,
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
  readonly features = { mediaIndexing: true } as const;

  // Resolve the shared service only for a write; metadata queries remain pure.
  constructor(private readonly sharedStorageService?: SharedStorageService) {}

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
    for (const file of requests) {
      if (file.target.domain !== "media_library") {
        throw new ActionableError(
          `Android media-library provider received unsupported target domain: ${file.target.domain}`,
        );
      }
      if (!hasSupportedMediaLibraryExtension(file.destinationPath)) {
        throw new ActionableError(
          `Android media-library fixture ${file.destinationPath} must use an image, video, or audio filename supported by Android MediaStore.`,
        );
      }
    }
    const result = await (this.sharedStorageService ?? getSharedStorageService()).stage({
      device: request.device,
      ...(request.userId === undefined ? {} : { explicitUserId: request.userId }),
      namespace: ANDROID_MEDIA_LIBRARY_NAMESPACE,
      files: requests.map((file) => ({
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
      })),
      signal: request.signal,
      rollbackOnFailure: true,
      requireMediaIndexing: true,
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
    if (resolveIosDeviceKind({ deviceId: request.device.deviceId }) !== "simulator") {
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

/** The managed fixture app is a follow-up; no provider auto-install occurs here. */
export const IOS_FILES_FIXTURE_BUNDLE_ID = "dev.jasonpearson.automobile.FilesFixture";

/** Host staging only; completion makes no assertion about document-picker visibility. */
export interface IosFilesFixtureContainer {
  stageFiles(requests: readonly PutAppFileProviderRequest[]): Promise<void>;
}

export interface DocumentPickerVisibilityVerifier {
  verify(request: {
    device: BootedDevice;
    namespace: string;
    destinationPath: string;
    signal?: AbortSignal;
  }): Promise<{ status: "completed" | "unavailable"; reason?: string }>;
}

const unverifiedDocumentPicker: DocumentPickerVisibilityVerifier = {
  verify: async () => ({
    status: "unavailable",
    reason:
      "Picker visibility is unavailable: no document-picker verifier observed the destination.",
  }),
};

function validateIosFilesDeviceTarget(device: BootedDevice, target: PutAppFileTarget): void {
  if (device.platform === "ios" && target.domain === "user_files") {
    requireIosFilesSimulator(device);
  }
}

function requireIosFilesSimulator(device: BootedDevice): void {
  if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
    throw new ActionableError(
      `iOS user_files staging is only supported on iOS Simulators. Device ${device.deviceId} looks like a physical iOS device. ` +
        "Physical iOS is unsupported without an on-device fixture-app integration.",
    );
  }
}

function normalizeIosFilesRequest(
  request: PutAppFileProviderRequest,
): PutAppFileProviderRequest & { target: UserFilesTarget } {
  requireIosFilesSimulator(request.device);
  if (request.target.domain !== "user_files") {
    throw new ActionableError("iOS Files fixture provider requires target.domain user_files.");
  }
  if (win32.isAbsolute(request.destinationPath) || /^[A-Za-z]:/.test(request.destinationPath)) {
    throw new ActionableError(
      "iOS Files destinationPath must be relative, without an absolute path or drive-letter prefix.",
    );
  }
  return {
    ...request,
    target: { ...request.target, namespace: normalizeUserFilesNamespace(request.target.namespace) },
    destinationPath: normalizeAppFileRelativePath(request.destinationPath),
  };
}

export class IosSimulatorUserFilesProvider implements AppFileWriteProvider {
  readonly platform = "ios" as const;
  readonly domain = "user_files" as const;
  readonly features = { namespaceReset: true } as const;

  constructor(
    private readonly container: IosFilesFixtureContainer,
    private readonly verifier: DocumentPickerVisibilityVerifier = unverifiedDocumentPicker,
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<AppFileProviderWriteResult> {
    return (await this.putFiles([request]))[0]!;
  }

  async putFiles(requests: PutAppFileProviderRequest[]): Promise<AppFileProviderWriteResult[]> {
    const normalized = requests.map(normalizeIosFilesRequest);
    await this.container.stageFiles(normalized);
    const results: AppFileProviderWriteResult[] = [];
    for (const request of normalized) {
      let visibility: Awaited<ReturnType<DocumentPickerVisibilityVerifier["verify"]>>;
      try {
        visibility = await this.verifier.verify({
          device: request.device,
          namespace: request.target.namespace,
          destinationPath: request.destinationPath,
          signal: request.signal,
        });
      } catch (error) {
        logger.warn(
          `Failed to verify iOS document picker visibility: ${errorMessage(error)}`,
          error,
        );
        visibility = {
          status: "unavailable",
          reason: `Document-picker verification failed: ${errorMessage(error)}`,
        };
      }
      results.push({
        effects: [
          { type: "host_stage", status: "completed" },
          { type: "document_picker", ...visibility },
        ],
      });
    }
    return results;
  }
}

/** Resolves runtime metadata only; writes and reset never target an undocumented Files path. */
export class SimctlIosFilesFixtureContainer implements IosFilesFixtureContainer {
  private tempIndex = 0;

  constructor(
    private readonly simctlFactory: (device: BootedDevice) => SimCtlClient,
    private readonly fileSystem: AppFileFileSystem,
  ) {}

  async stageFiles(requests: readonly PutAppFileProviderRequest[]): Promise<void> {
    const normalized = requests.map(normalizeIosFilesRequest);
    const roots = new Map<string, string>();
    const destinations: Array<{
      request: PutAppFileProviderRequest & { target: UserFilesTarget };
      namespace: string;
      target: string;
    }> = [];
    for (const request of normalized) {
      let container = roots.get(request.device.deviceId);
      if (container === undefined) {
        container = await this.resolveContainer(request);
        roots.set(request.device.deviceId, container);
      }
      const root = resolve(container, "Documents", "automobile");
      const namespace = resolve(root, request.target.namespace);
      const target = resolve(namespace, request.destinationPath);
      this.assertBelow(root, namespace);
      this.assertBelow(namespace, target);
      this.assertBelow(root, target);
      await this.assertNoSymlinks(container, target);
      destinations.push({ request, namespace, target });
    }
    // Validate every destination before any reset or copy. buildProviderRequests
    // marks only the first file reset=true; also bound direct batches to one reset per namespace.
    const resetNamespaces = new Set<string>();
    for (const { request, namespace, target } of destinations) {
      if (request.target.reset && !resetNamespaces.has(namespace)) {
        await this.fileSystem.rm(namespace);
        resetNamespaces.add(namespace);
      }
      const index = ++this.tempIndex;
      const temporary = iosAtomicTemporaryPath(target, index);
      await this.assertNoSymlinks(roots.get(request.device.deviceId)!, temporary);
      await writeIosFileAtomically(this.fileSystem, request.sourcePath, target, index);
    }
  }

  private assertBelow(root: string, target: string): void {
    const path = relative(root, target);
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new ActionableError(
        "iOS Files fixture destination must remain strictly below its managed namespace root.",
      );
    }
  }

  private async assertNoSymlinks(container: string, target: string): Promise<void> {
    const parts = relative(container, target).split(sep);
    let current = container;
    for (const part of parts) {
      current = join(current, part);
      let stats: AppFileStats;
      try {
        stats = await this.fileSystem.lstat(current);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw toActionableError(
            error,
            `Failed to check iOS Files fixture containment at ${current}`,
          );
        }
        // Missing descendants will be created by the bounded atomic write.
        logger.debug(`iOS Files fixture path does not exist yet: ${current}`);
        continue;
      }
      if (
        (!stats.isDirectory() && !stats.isFile()) ||
        (current !== target && !stats.isDirectory())
      ) {
        throw new ActionableError(
          `Refusing iOS Files fixture symlink or non-directory containment path: ${current}`,
        );
      }
    }
  }

  private async resolveContainer(request: PutAppFileProviderRequest): Promise<string> {
    const guidance = `Install the managed iOS Files fixture app (${IOS_FILES_FIXTURE_BUNDLE_ID}) on the booted simulator and retry; no alternate storage path is used.`;
    let output: ExecResult;
    try {
      output = await this.simctlFactory(request.device).executeCommandArgs(
        ["get_app_container", request.device.deviceId, IOS_FILES_FIXTURE_BUNDLE_ID, "data"],
        5_000,
        request.signal,
      );
    } catch (error) {
      throw toActionableError(
        error,
        `Unable to resolve the managed iOS Files fixture container. ${guidance}`,
      );
    }
    const container = output.stdout.trim();
    if (!container || !isAbsolute(container)) {
      throw new ActionableError(
        `Unable to resolve the managed iOS Files fixture container. ${guidance}`,
      );
    }
    return container;
  }
}

function iosAtomicTemporaryPath(target: string, index: number): string {
  return join(dirname(target), `.${basename(target)}.${index}.tmp`);
}

/** Shared atomic copy; callers retain their own ordering and temporary-file sequence. */
async function writeIosFileAtomically(
  fileSystem: AppFileFileSystem,
  sourcePath: string,
  target: string,
  index: number,
): Promise<void> {
  const temporary = iosAtomicTemporaryPath(target, index);
  try {
    await fileSystem.mkdir(dirname(target));
    await fileSystem.copyFile(sourcePath, temporary);
    await fileSystem.rename(temporary, target);
  } catch (error) {
    try {
      await fileSystem.rm(temporary);
    } catch (cleanupError) {
      logger.warn(
        `Failed to remove partial iOS app file at ${temporary}: ${errorMessage(cleanupError)}`,
        cleanupError,
      );
    }
    // Preserve the original write error for callers and existing provider contracts.
    throw error;
  }
}

interface IosWrittenFile {
  target: string;
  destinationPath: string;
  /** Copy of the content this write replaced; absent when the destination was newly created. */
  backup?: string;
  preexisting: boolean;
}

class IosSimulatorAppFileProvider
  implements AppFileWriteProvider, AppFileListProvider, AppFileReadProvider
{
  readonly platform = "ios" as const;
  readonly domain = "app_containers" as const;
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private tempIndex = 0;

  constructor(
    private readonly simctlFactory: (device: BootedDevice) => SimCtlClient,
    private readonly fileSystem: AppFileFileSystem,
  ) {}

  async putFile(request: PutAppFileProviderRequest): Promise<AppFileProviderWriteResult> {
    return (await this.putFiles([request]))[0]!;
  }

  async putFiles(requests: PutAppFileProviderRequest[]): Promise<AppFileProviderWriteResult[]> {
    const roots = new Map<string, string>();
    const targets: string[] = [];
    for (const request of requests) {
      const appTarget = requireAppContainersTarget(request.target);
      const key = JSON.stringify([request.device.deviceId, appTarget.appId, appTarget.container]);
      let root = roots.get(key);
      if (root === undefined) {
        root = await this.resolveContainerRoot(
          request.device,
          appTarget.appId,
          appTarget.container,
          "putFile",
        );
        roots.set(key, root);
      }
      targets.push(join(root, normalizeAppFileRelativePath(request.destinationPath)));
    }
    await this.writeBatch(requests, targets);
    // Keep confirmation separate from container resolution and atomic writes.
    const runningStates = new Map<string, boolean | undefined>();
    for (const request of requests) {
      const appTarget = requireAppContainersTarget(request.target);
      const key = JSON.stringify([request.device.deviceId, appTarget.appId]);
      if (runningStates.has(key)) {
        continue;
      }
      try {
        const output = await this.simctlFactory(request.device).executeCommandArgs(
          ["spawn", request.device.deviceId, "launchctl", "list"],
          5_000,
          request.signal,
        );
        const process = findIosSimulatorAppProcess(output.stdout, appTarget.appId);
        if (process) {
          runningStates.set(key, true);
        } else if (/^PID\s+Status\s+Label\s*$/m.test(output.stdout)) {
          runningStates.set(key, false);
        } else {
          logger.warn(
            `Unable to read iOS running state for ${appTarget.appId}: unparseable launchctl output`,
          );
          runningStates.set(key, undefined);
        }
      } catch (error) {
        // A failed or aborted optional check cannot undo a completed file write.
        logger.warn(
          `Failed to check iOS running state for ${appTarget.appId}: ${errorMessage(error)}`,
          error,
        );
        runningStates.set(key, undefined);
      }
    }
    return requests.map((request) => ({
      appRunning: runningStates.get(
        JSON.stringify([request.device.deviceId, requireAppContainersTarget(request.target).appId]),
      ),
    }));
  }

  /**
   * Writes every file, waits for all of them to settle, and on any failure undoes the ones this
   * call committed so the container keeps its pre-call state (matching the Android provider).
   */
  private async writeBatch(
    requests: PutAppFileProviderRequest[],
    targets: string[],
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      // A single-file write has no earlier file to roll back, so it needs no backup.
      requests.map((request, index) =>
        this.writeFile(request, targets[index]!, requests.length > 1),
      ),
    );
    const written: IosWrittenFile[] = [];
    let failure: { reason: unknown; destinationPath: string } | undefined;
    for (const [index, outcome] of outcomes.entries()) {
      const destinationPath = requests[index]!.destinationPath;
      if (outcome.status === "fulfilled") {
        written.push({ ...outcome.value, destinationPath });
      } else if (failure === undefined) {
        failure = { reason: outcome.reason, destinationPath };
      }
    }
    if (failure === undefined) {
      await this.discardBackups(written);
      return;
    }
    if (written.length === 0) {
      // Nothing was committed, so there is nothing to undo; keep the original error.
      throw failure.reason;
    }
    const rollback = await this.rollbackWrites(written);
    const list = (entries: string[]) => (entries.length > 0 ? entries.join(", ") : "none");
    throw new ActionableError(
      `iOS app-container batch write failed for ${failure.destinationPath}: ${errorMessage(failure.reason)} ` +
        `Rolled back: ${list(rollback.rolledBack)}. ` +
        `Left modified (previous content not restored): ${list(rollback.leftModified)}. ` +
        `Rollback failures: ${rollback.failures.join("; ") || "none"}.`,
      { cause: failure.reason },
    );
  }

  private async rollbackWrites(written: IosWrittenFile[]): Promise<{
    rolledBack: string[];
    leftModified: string[];
    failures: string[];
  }> {
    const rolledBack: string[] = [];
    const leftModified: string[] = [];
    const failures: string[] = [];
    for (const file of [...written].reverse()) {
      try {
        if (file.backup !== undefined) {
          await this.fileSystem.rename(file.backup, file.target);
        } else if (file.preexisting) {
          // Existed but could not be copied aside (not a regular file); never delete it.
          leftModified.push(file.destinationPath);
          continue;
        } else {
          await this.fileSystem.rm(file.target);
        }
        rolledBack.push(file.destinationPath);
      } catch (error) {
        failures.push(`${file.destinationPath}: ${errorMessage(error)}`);
        logger.warn(
          `Failed to roll back iOS app file ${file.target}: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return { rolledBack, leftModified, failures };
  }

  private async discardBackups(written: IosWrittenFile[]): Promise<void> {
    for (const file of written) {
      if (file.backup === undefined) {
        continue;
      }
      try {
        await this.fileSystem.rm(file.backup);
      } catch (error) {
        // The write already succeeded; a stray hidden backup must not fail it.
        logger.warn(
          `Failed to remove iOS app file backup ${file.backup}: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }

  private async writeFile(
    request: PutAppFileProviderRequest,
    target: string,
    keepPrevious: boolean,
  ): Promise<{ target: string; backup?: string; preexisting: boolean }> {
    const run = async () => {
      const previous = keepPrevious ? await this.saveExisting(target) : { preexisting: false };
      try {
        await writeIosFileAtomically(this.fileSystem, request.sourcePath, target, ++this.tempIndex);
      } catch (error) {
        if (previous.backup !== undefined) {
          await this.discardBackups([{ ...previous, target, destinationPath: target }]);
        }
        throw error;
      }
      return { target, ...previous };
    };
    const earlier = this.pendingWrites.get(target);
    const write = earlier ? earlier.then(run, run) : run();
    const settled = write.then(() => undefined);
    this.pendingWrites.set(target, settled);
    const clear = () => {
      if (this.pendingWrites.get(target) === settled) {
        this.pendingWrites.delete(target);
      }
    };
    void settled.then(clear, clear);
    return await write;
  }

  /** Copies a file this write is about to replace aside so a failed batch can restore it. */
  private async saveExisting(target: string): Promise<{ backup?: string; preexisting: boolean }> {
    let stats: AppFileStats;
    try {
      stats = await this.fileSystem.lstat(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { preexisting: false };
      }
      throw toActionableError(error, `Failed to inspect existing iOS app file at ${target}`);
    }
    if (!stats.isFile()) {
      return { preexisting: true };
    }
    const backup = join(dirname(target), `.${basename(target)}.${++this.tempIndex}.bak`);
    try {
      await this.fileSystem.copyFile(target, backup);
    } catch (error) {
      await this.discardBackups([{ target, destinationPath: target, backup, preexisting: true }]);
      throw error;
    }
    return { backup, preexisting: true };
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
    const containerRoot = await this.resolveContainerRoot(device, appId, container, operation);
    return path === undefined
      ? containerRoot
      : join(containerRoot, normalizeAppFileRelativePath(path));
  }

  private async resolveContainerRoot(
    device: BootedDevice,
    appId: string,
    container: AppFileContainer,
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

    if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
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

    return join(dataRoot, iosContainerRelativePath(container, operation, appId, device.platform));
  }
}

async function findBootedDevice(deviceId: string): Promise<BootedDevice> {
  const device = await findBootedDeviceForResource(deviceId, "AppFileService");
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

export type AndroidTarget =
  | { kind: "runAs"; relativePath: string }
  | { kind: "external"; absolutePath: string }
  | { kind: "unsupported"; message: string };

export function resolveAndroidTarget(
  appId: string,
  container: AppFileContainer,
  path: string,
  userId = 0,
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
      // Preserve verified user-0 argv. Unverified, from Android scoped-storage
      // documentation: on API 30+, shell read/list access to other apps' Android/data
      // directories is not guaranteed and push can be denied. This corrects the
      // user path only; plain adb shell/push does not bypass scoped storage.
      return {
        kind: "external",
        absolutePath: `${userId === 0 ? "/sdcard" : `/storage/emulated/${userId}`}/Android/data/${appId}/files/${safePath}`,
      };
    case "library":
      return {
        kind: "unsupported",
        message:
          "library is not available for Android app containers. Use documents, cache, tmp, or externalFiles.",
      };
  }
}

export function iosContainerRelativePath(
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

export type LocalFileListEntry = Omit<AppFileListEntry, "resourceUri">;

export async function listLocalFiles(
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
  /** The logical container named in error messages (an app container or an App Group id). */
  container: string;
  operation: string;
}

export async function executeIosAppContainerCommand(
  simctl: Pick<SimCtlClient, "executeCommand">,
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
  userId?: number;
  device: BootedDevice;
  appId: string;
  container: AppFileContainer;
  operation: "write" | "list" | "read" | "reset";
  access: "externalFiles" | "run-as";
}

interface AndroidAppFileExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  noRetry?: boolean;
  signal?: AbortSignal;
}

export async function executeAndroidAppFileCommand(
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
    throw mapAndroidAppFileError(error, context, command);
  }
}

function mapAndroidAppFileError(
  error: unknown,
  context: AndroidAppFileCommandContext,
  command: string,
): ActionableError {
  const message = errorMessage(error);
  const user = context.userId ? ` for user ${context.userId}` : "";
  if (/not debuggable/i.test(message)) {
    return new ActionableError(
      `Android ${context.container} app file ${context.operation} for ${context.appId}${user} on ${context.device.deviceId} ` +
        "requires a debuggable app build because it uses run-as. Install a debuggable build or use externalFiles. " +
        `Original error: ${message}`,
    );
  }

  if (
    /package .* (unknown|not found)|unknown package|not installed|does not exist/i.test(message)
  ) {
    return new ActionableError(
      `Android app ${context.appId} is not installed${user} on ${context.device.deviceId}; ` +
        `cannot ${context.operation} ${context.container} app files. Original error: ${message}`,
    );
  }

  if (/permission denied|operation not permitted/i.test(message)) {
    return new ActionableError(
      `Android ${context.container} app file ${context.operation} for ${context.appId}${user} on ${context.device.deviceId} ` +
        `was denied by the device. ${context.access === "run-as" ? "Use a debuggable build for private storage or choose externalFiles." : "Check app install state and external storage access."} ` +
        `Original error: ${message}`,
    );
  }

  if (
    context.access === "run-as" &&
    command.includes(" --user ") &&
    (/^\s*run-as: (unknown|invalid|unrecognized) option\b/im.test(message) ||
      /^\s*usage: run-as\b/im.test(message))
  ) {
    return new ActionableError(
      `run-as --user appears unsupported on ${context.device.deviceId}'s Android version (unverified which API level)${user}. Omit userId only if the app is installed for the device's primary user, or use a debuggable build via an adb-user-0 session. Original error: ${message}`,
    );
  }

  return new ActionableError(
    `Failed to ${context.operation} Android ${context.container} app files for ${context.appId} on ${context.device.deviceId}: ${message}`,
  );
}

export function decodeUtf8Text(buffer: Buffer): string | undefined {
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
