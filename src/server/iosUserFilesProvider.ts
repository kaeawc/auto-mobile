import { createHash } from "node:crypto";
import { existsSync, promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootedDevice, ExecResult } from "../models";
import { ActionableError } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../utils/logger";
import { XcodebuildClient, type Xcodebuild } from "../utils/ios-cmdline-tools/XcodebuildClient";
import {
  normalizeAppFileRelativePath,
  normalizeUserFilesNamespace,
  type PutAppFileWriteEffect,
} from "./appFileContract";
import type {
  AppFileStats,
  AppFileWriteProvider,
  PutAppFileProviderRequest,
} from "./appFileService";

export const IOS_FILES_FIXTURE_BUNDLE_ID = "dev.jasonpearson.automobile.files-fixture-provider";
export const IOS_FILES_FIXTURE_CONTAINER_TIMEOUT_MS = 15_000;
const MANAGED_DIRECTORY = "automobile";
const PICKER_MARKER_RELATIVE_PATH = posix.join(
  "Library",
  "Application Support",
  "AutoMobile",
  "picker-visibility.json",
);
const STAGING_IDENTITIES_RELATIVE_PATH = posix.join(
  "Library",
  "Application Support",
  "AutoMobile",
  "staging-identities",
);

export interface IosFilesFixtureContainerResolution {
  dataRoot: string;
  managedRoot: string;
}

export interface IosFilesFixtureContainer {
  resolve(device: BootedDevice, signal?: AbortSignal): Promise<IosFilesFixtureContainerResolution>;
  isAvailable(device: BootedDevice, signal?: AbortSignal): Promise<boolean>;
  resetNamespace(resolution: IosFilesFixtureContainerResolution, namespace: string): Promise<void>;
  putFile(
    resolution: IosFilesFixtureContainerResolution,
    namespace: string,
    destinationPath: string,
    sourcePath: string,
  ): Promise<IosFilesStagedFixture>;
}

export interface IosFilesStagedFixture {
  stagedPath: string;
  generation: string;
}

export interface DocumentPickerVisibilityRequest {
  resolution: IosFilesFixtureContainerResolution;
  namespace: string;
  destinationPath: string;
  stagedPath: string;
  generation: string;
  byteCount: number;
}

export interface DocumentPickerVisibilityVerifier {
  verify(request: DocumentPickerVisibilityRequest): Promise<PutAppFileWriteEffect>;
}

export interface IosFilesFixtureFileSystem {
  lstat(path: string): Promise<AppFileStats>;
  mkdir(path: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  readFileBuffer(path: string): Promise<Buffer>;
  writeFileBuffer(path: string, data: Buffer): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface IosFilesFixtureSimctl {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export interface IosFilesFixtureInstaller {
  isInstallable(): Promise<boolean>;
  ensureInstalled(device: BootedDevice, signal?: AbortSignal): Promise<void>;
}

interface IosFilesFixtureInstallerFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
}

const nodeIosFilesFixtureFileSystem: IosFilesFixtureFileSystem = {
  lstat: async (path) => nodeFs.lstat(path),
  mkdir: async (path) => {
    await nodeFs.mkdir(path, { recursive: true });
  },
  copyFile: async (sourcePath, destinationPath) => {
    await nodeFs.copyFile(sourcePath, destinationPath);
  },
  readFileBuffer: async (path) => nodeFs.readFile(path),
  writeFileBuffer: async (path, data) => nodeFs.writeFile(path, data),
  mkdtemp: async (prefix) => nodeFs.mkdtemp(prefix),
  rename: async (sourcePath, destinationPath) => nodeFs.rename(sourcePath, destinationPath),
  rm: async (path) => {
    await nodeFs.rm(path, { recursive: true, force: true });
  },
};

function defaultFixtureProjectPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../ios/FilesFixtureProvider/FilesFixtureProvider.xcodeproj"),
    resolve(moduleDirectory, "../ios/FilesFixtureProvider/FilesFixtureProvider.xcodeproj"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export class XcodebuildIosFilesFixtureInstaller implements IosFilesFixtureInstaller {
  private readonly installations = new Map<string, Promise<void>>();

  constructor(
    private readonly container: IosFilesFixtureContainer,
    private readonly simctlFactory: (device: BootedDevice) => IosFilesFixtureSimctl,
    private readonly xcodebuild: Xcodebuild,
    private readonly projectPath: string = defaultFixtureProjectPath(),
    private readonly fileSystem: IosFilesFixtureInstallerFileSystem = nodeIosFilesFixtureFileSystem,
  ) {}

  async isInstallable(): Promise<boolean> {
    return existsSync(this.projectPath) && (await this.xcodebuild.isAvailable());
  }

  async ensureInstalled(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    assertSimulator(device);
    if (await this.container.isAvailable(device, signal)) {
      return;
    }
    const existing = this.installations.get(device.deviceId);
    if (existing) {
      return existing;
    }
    const installation = this.buildAndInstall(device, signal).finally(() => {
      this.installations.delete(device.deviceId);
    });
    this.installations.set(device.deviceId, installation);
    return installation;
  }

  private async buildAndInstall(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    if (!(await this.isInstallable())) {
      throw new ActionableError(
        "The packaged AutoMobile Files fixture provider or xcodebuild is unavailable. " +
          "Install Xcode and reinstall AutoMobile before staging iOS user_files.",
      );
    }
    const derivedData = await this.fileSystem.mkdtemp(
      join(tmpdir(), "automobile-files-fixture-provider."),
    );
    try {
      await this.xcodebuild.executeCommand(
        [
          "-project",
          this.projectPath,
          "-scheme",
          "FilesFixtureProvider",
          "-sdk",
          "iphonesimulator",
          "-destination",
          `platform=iOS Simulator,id=${device.deviceId}`,
          "-derivedDataPath",
          derivedData,
          "build",
        ],
        { timeoutMs: 180_000, signal },
      );
      const appPath = posix.join(
        derivedData,
        "Build",
        "Products",
        "Debug-iphonesimulator",
        "AutoMobile Files.app",
      );
      await this.simctlFactory(device).executeCommandArgs(
        ["install", device.deviceId, appPath],
        60_000,
        signal,
      );
      if (!(await this.container.isAvailable(device, signal))) {
        throw new ActionableError(
          `The managed AutoMobile Files fixture provider did not resolve after installation on ${device.deviceId}.`,
        );
      }
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(
        `Failed to build and install the managed AutoMobile Files fixture provider: ${errorMessage(error)}`,
      );
    } finally {
      await this.fileSystem.rm(derivedData);
    }
  }
}

export function createDefaultIosFilesFixtureInstaller(
  container: IosFilesFixtureContainer,
  simctlFactory: (device: BootedDevice) => SimCtlClient,
): IosFilesFixtureInstaller {
  return new XcodebuildIosFilesFixtureInstaller(container, simctlFactory, new XcodebuildClient());
}

export class SimctlIosFilesFixtureContainer implements IosFilesFixtureContainer {
  constructor(
    private readonly simctlFactory: (device: BootedDevice) => IosFilesFixtureSimctl,
    private readonly fileSystem: IosFilesFixtureFileSystem = nodeIosFilesFixtureFileSystem,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
  ) {}

  async resolve(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<IosFilesFixtureContainerResolution> {
    assertSimulator(device);
    let result: ExecResult;
    try {
      result = await this.simctlFactory(device).executeCommandArgs(
        ["get_app_container", device.deviceId, IOS_FILES_FIXTURE_BUNDLE_ID, "data"],
        IOS_FILES_FIXTURE_CONTAINER_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      const message = errorMessage(error);
      if (
        /not installed|application.*not.*installed|no such app|bundle.*not found/i.test(message)
      ) {
        throw new ActionableError(
          `The managed iOS Files fixture provider is not installed on simulator ${device.deviceId}. ` +
            "Install the AutoMobile FilesFixtureProvider app before staging user_files.",
        );
      }
      if (/no such device|invalid device|unavailable|shutdown|not booted/i.test(message)) {
        throw new ActionableError(
          `iOS simulator ${device.deviceId} is unavailable or not booted; cannot resolve the managed Files fixture provider.`,
        );
      }
      throw new ActionableError(
        `Failed to resolve the managed iOS Files fixture provider on ${device.deviceId}: ${message}`,
      );
    }

    const dataRoot = result.stdout.trim();
    if (!dataRoot) {
      throw new ActionableError(
        `The managed iOS Files fixture provider returned no data container on ${device.deviceId}. ` +
          "Confirm the provider app is installed.",
      );
    }
    if (!posix.isAbsolute(dataRoot)) {
      throw new ActionableError(
        `The managed iOS Files fixture provider did not return an absolute data container path on ${device.deviceId}.`,
      );
    }
    return {
      dataRoot,
      managedRoot: posix.join(dataRoot, "Documents", MANAGED_DIRECTORY),
    };
  }

  async isAvailable(device: BootedDevice, signal?: AbortSignal): Promise<boolean> {
    if (!isIosSimulatorUdid(device.deviceId)) {
      return false;
    }
    try {
      await this.resolve(device, signal);
      return true;
    } catch (error) {
      logger.debug(
        `[iOS Files] Managed fixture provider is unavailable on ${device.deviceId}: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  async resetNamespace(
    resolution: IosFilesFixtureContainerResolution,
    namespace: string,
  ): Promise<void> {
    const safeNamespace = normalizeUserFilesNamespace(namespace);
    const namespaceRoot = containedPath(resolution.managedRoot, safeNamespace);
    const identityRoot = containedPath(
      posix.join(resolution.dataRoot, STAGING_IDENTITIES_RELATIVE_PATH),
      safeNamespace,
    );
    await this.assertDirectoryChain(resolution.dataRoot, namespaceRoot);
    await this.assertDirectoryChain(resolution.dataRoot, identityRoot);
    await this.fileSystem.rm(namespaceRoot);
    await this.fileSystem.rm(identityRoot);
  }

  async putFile(
    resolution: IosFilesFixtureContainerResolution,
    namespace: string,
    destinationPath: string,
    sourcePath: string,
  ): Promise<IosFilesStagedFixture> {
    const safeNamespace = normalizeUserFilesNamespace(namespace);
    const safeDestination = normalizeAppFileRelativePath(destinationPath);
    const namespaceRoot = containedPath(resolution.managedRoot, safeNamespace);
    const destination = containedPath(namespaceRoot, safeDestination);
    const parent = posix.dirname(destination);
    await this.assertDirectoryChain(resolution.dataRoot, parent);
    await this.fileSystem.mkdir(parent);
    await this.assertDirectoryChain(resolution.dataRoot, parent);
    await this.assertRegularFileOrMissing(destination);
    const sourceBytes = await this.fileSystem.readFileBuffer(sourcePath);
    const sourceHash = sha256(sourceBytes);
    const identityPath = containedPath(
      posix.join(resolution.dataRoot, STAGING_IDENTITIES_RELATIVE_PATH, safeNamespace),
      stagingIdentityFileName(safeDestination),
    );
    const existingGeneration = await this.reusableGeneration(
      destination,
      identityPath,
      sourceBytes.byteLength,
      sourceHash,
    );
    const generation = existingGeneration ?? this.idGenerator.next();
    const stageDirectory = await this.fileSystem.mkdtemp(posix.join(parent, ".automobile-stage-"));
    try {
      const stagedCopy = posix.join(stageDirectory, "fixture");
      await this.fileSystem.copyFile(sourcePath, stagedCopy);
      await this.fileSystem.rename(stagedCopy, destination);
    } finally {
      await this.fileSystem.rm(stageDirectory);
    }
    await this.writeIdentity(resolution.dataRoot, identityPath, {
      schemaVersion: 1,
      byteCount: sourceBytes.byteLength,
      sha256: sourceHash,
      generation,
    });
    return { stagedPath: destination, generation };
  }

  private async reusableGeneration(
    destination: string,
    identityPath: string,
    byteCount: number,
    hash: string,
  ): Promise<string | undefined> {
    try {
      const destinationBytes = await this.fileSystem.readFileBuffer(destination);
      const identity = JSON.parse(
        (await this.fileSystem.readFileBuffer(identityPath)).toString("utf8"),
      ) as Partial<StagingIdentity>;
      return identity.schemaVersion === 1 &&
        identity.byteCount === byteCount &&
        identity.sha256 === hash &&
        sha256(destinationBytes) === hash &&
        typeof identity.generation === "string" &&
        identity.generation.length > 0
        ? identity.generation
        : undefined;
    } catch (error) {
      logger.debug(`[iOS Files] Existing staging identity is unavailable: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async writeIdentity(
    dataRoot: string,
    identityPath: string,
    identity: StagingIdentity,
  ): Promise<void> {
    const parent = posix.dirname(identityPath);
    await this.assertDirectoryChain(dataRoot, parent);
    await this.fileSystem.mkdir(parent);
    await this.assertDirectoryChain(dataRoot, parent);
    const temporaryDirectory = await this.fileSystem.mkdtemp(posix.join(parent, ".automobile-identity-"));
    try {
      const temporaryPath = posix.join(temporaryDirectory, "identity.json");
      await this.fileSystem.writeFileBuffer(temporaryPath, Buffer.from(JSON.stringify(identity)));
      await this.fileSystem.rename(temporaryPath, identityPath);
    } finally {
      await this.fileSystem.rm(temporaryDirectory);
    }
  }

  private async assertDirectoryChain(root: string, target: string): Promise<void> {
    const relativeTarget = posix.relative(root, target);
    if (isOutsideRoot(relativeTarget)) {
      throw new ActionableError("Refusing to stage an iOS Files fixture outside its managed root.");
    }
    const segments = relativeTarget.split("/").filter(Boolean);
    let current = root;
    await this.assertDirectoryOrMissing(current);
    for (const segment of segments) {
      current = posix.join(current, segment);
      await this.assertDirectoryOrMissing(current);
    }
  }

  private async assertDirectoryOrMissing(path: string): Promise<void> {
    try {
      const stat = await this.fileSystem.lstat(path);
      if (!stat.isDirectory()) {
        throw new ActionableError(`Refusing to follow non-directory fixture path: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async assertRegularFileOrMissing(path: string): Promise<void> {
    try {
      const stat = await this.fileSystem.lstat(path);
      if (!stat.isFile()) {
        throw new ActionableError(`Refusing to replace non-file fixture path: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

interface PickerVisibilityMarker {
  schemaVersion: 2;
  namespace: string;
  destinationPath: string;
  byteCount: number;
  sha256: string;
  generation: string;
}

interface StagingIdentity {
  schemaVersion: 1;
  byteCount: number;
  sha256: string;
  generation: string;
}

export class MarkerDocumentPickerVisibilityVerifier implements DocumentPickerVisibilityVerifier {
  constructor(
    private readonly fileSystem: Pick<
      IosFilesFixtureFileSystem,
      "readFileBuffer"
    > = nodeIosFilesFixtureFileSystem,
  ) {}

  async verify(request: DocumentPickerVisibilityRequest): Promise<PutAppFileWriteEffect> {
    try {
      const markerPath = posix.join(request.resolution.dataRoot, PICKER_MARKER_RELATIVE_PATH);
      const marker = JSON.parse(
        (await this.fileSystem.readFileBuffer(markerPath)).toString("utf8"),
      ) as Partial<PickerVisibilityMarker>;
      const stagedHash = sha256(await this.fileSystem.readFileBuffer(request.stagedPath));
      if (
        marker.schemaVersion === 2 &&
        marker.namespace === request.namespace &&
        marker.destinationPath === request.destinationPath &&
        marker.byteCount === request.byteCount &&
        marker.sha256 === stagedHash &&
        marker.generation === request.generation
      ) {
        return {
          type: "document_picker",
          status: "completed",
          reason:
            "The managed fixture app observed this exact logical destination in UIDocumentPickerViewController.",
        };
      }
    } catch (error) {
      // Absence, malformed app-owned state, and read failures all mean the
      // independent picker observation is unavailable; host staging still stands.
      logger.debug(`[iOS Files] Picker visibility marker is unavailable: ${errorMessage(error)}`);
    }
    return unavailablePickerEffect();
  }
}

export class IosUserFilesProvider implements AppFileWriteProvider {
  readonly platform = "ios" as const;
  readonly domain = "user_files" as const;

  constructor(
    private readonly container: IosFilesFixtureContainer,
    private readonly visibilityVerifier: DocumentPickerVisibilityVerifier,
    private readonly installer?: IosFilesFixtureInstaller,
  ) {}

  async putFile(request: PutAppFileProviderRequest) {
    return (await this.putFiles([request]))[0];
  }

  async putFiles(requests: PutAppFileProviderRequest[]) {
    if (requests.length === 0) {
      return [];
    }
    const first = requests[0]!;
    assertSimulator(first.device);
    if (first.target.domain !== "user_files") {
      throw new ActionableError(
        `iOS user-files provider received unsupported target domain: ${first.target.domain}`,
      );
    }
    const namespace = normalizeUserFilesNamespace(first.target.namespace);
    for (const request of requests) {
      if (request.target.domain !== "user_files" || request.target.namespace !== namespace) {
        throw new ActionableError("Every iOS user_files batch entry must use one namespace.");
      }
    }

    await this.installer?.ensureInstalled(first.device, first.signal);
    const resolution = await this.container.resolve(first.device, first.signal);
    if (first.target.reset === true) {
      await this.container.resetNamespace(resolution, namespace);
    }

    return Promise.all(
      requests.map(async (request) => {
        const destinationPath = normalizeAppFileRelativePath(request.destinationPath);
        const stagedFixture = await this.container.putFile(
          resolution,
          namespace,
          destinationPath,
          request.sourcePath,
        );
        const pickerEffect = await this.visibilityVerifier.verify({
          resolution,
          namespace,
          destinationPath,
          stagedPath: stagedFixture.stagedPath,
          generation: stagedFixture.generation,
          byteCount: request.byteCount,
        });
        return {
          effects: [
            {
              type: "host_stage",
              status: "completed" as const,
              reason:
                `Staged in the managed iOS Files fixture namespace ${namespace} on ` +
                `${request.device.deviceId}.`,
            },
            pickerEffect,
          ],
        };
      }),
    );
  }
}

function assertSimulator(device: BootedDevice): void {
  if (!isIosSimulatorUdid(device.deviceId)) {
    throw new ActionableError(
      `iOS user_files staging is only supported on iOS simulators. ` +
        `Device ${device.deviceId} looks like a physical iOS device.`,
    );
  }
}

function containedPath(root: string, safeRelativePath: string): string {
  const candidate = posix.join(root, safeRelativePath);
  const relativeCandidate = posix.relative(root, candidate);
  if (
    relativeCandidate.length === 0 ||
    isOutsideRoot(relativeCandidate)
  ) {
    throw new ActionableError("Refusing to stage an iOS Files fixture outside its managed root.");
  }
  return candidate;
}

function unavailablePickerEffect(): PutAppFileWriteEffect {
  return {
    type: "document_picker",
    status: "unavailable",
    reason: "The exact fixture has not been observed by the document picker verifier.",
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stagingIdentityFileName(destinationPath: string): string {
  return `${createHash("sha256").update(destinationPath).digest("hex")}.json`;
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith("../") || posix.isAbsolute(relativePath);
}
