import {
  resolveOwnAppDataContainer,
  SimulatorContainerOwnershipError,
  SimulatorContainerUnresolvedError,
  type SimulatorContainerOwnershipOptions,
} from "../utils/ios-cmdline-tools/simulatorOwnContainer";
import {
  IOS_FILES_FIXTURE_BUNDLE_ID,
  normalizeIosFilesRequest,
  requireIosFilesSimulator,
  type IosFilesFixtureContainer,
} from "./IosSimulatorUserFilesProvider";
import { ActionableError, BootedDevice, toActionableError } from "../models";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import {
  type AppFileFileSystem,
  type AppFileStats,
  type PutAppFileProviderRequest,
} from "./appFileService";
import {
  iosAtomicTemporaryPath,
  listLocalFilesWithPaths,
  writeIosFileAtomically,
  type LocalFileListEntry,
} from "./appFileSupport";
import * as hostPath from "node:path";
import { posix, resolve } from "node:path";
import {
  UserFilesTarget,
  normalizeAppFileRelativePath,
  normalizeUserFilesNamespace,
} from "./appFileContract";
import type { IosFilesFixtureInstaller } from "./IosFilesFixtureInstaller";
import { isPathInside } from "../utils/filesystem/pathContainment";
import { logger } from "../utils/logger";

/** Resolves runtime metadata only; writes and reset never target an undocumented Files path. */
export class SimctlIosFilesFixtureContainer implements IosFilesFixtureContainer {
  private tempIndex = 0;

  constructor(
    private readonly simctlFactory: (
      device: BootedDevice,
    ) => Pick<SimCtlClient, "executeCommandArgs">,
    private readonly fileSystem: AppFileFileSystem,
    private readonly ownership: SimulatorContainerOwnershipOptions = {},
    private readonly installer?: IosFilesFixtureInstaller,
  ) {}

  /** Devices whose fixture app this instance installed during the current stage. */
  private installedDuringStage = new Set<string>();

  /** Read only the same managed namespace used by putAppFile. */
  async listNamespace(
    device: BootedDevice,
    namespace: string,
    signal?: AbortSignal,
  ): Promise<LocalFileListEntry[]> {
    const root = await this.resolveReadPath(device, namespace, undefined, signal);
    const stats = await this.fileSystem.lstat(root);
    if (!stats.isDirectory()) {
      throw new ActionableError("iOS Files namespace is not a directory.");
    }
    return (await listLocalFilesWithPaths(root, this.fileSystem, posix)).filter(
      (entry) => !entry.isDirectory,
    );
  }

  async readNamespaceFile(
    device: BootedDevice,
    namespace: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const target = await this.resolveReadPath(device, namespace, path, signal);
    const stats = await this.fileSystem.lstat(target);
    if (!stats.isFile() || stats.size > 64 * 1024 * 1024) {
      throw new ActionableError("iOS Files reads require a regular file of at most 64 MiB.");
    }
    return this.fileSystem.readFileBuffer(target);
  }

  private async resolveReadPath(
    device: BootedDevice,
    namespace: string,
    path?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    requireIosFilesSimulator(device);
    const container = await this.resolveContainer({ device, signal });
    // simctl returns macOS paths regardless of the platform running this reader.
    const root = posix.resolve(container, "Documents", "automobile");
    const managed = posix.resolve(root, normalizeUserFilesNamespace(namespace));
    this.assertBelow(root, managed, posix);
    const target =
      path === undefined ? managed : posix.resolve(managed, normalizeAppFileRelativePath(path));
    if (path !== undefined) {
      this.assertBelow(managed, target, posix);
    }
    await this.assertNoSymlinks(container, target, posix);
    return target;
  }

  async stageFiles(
    requests: readonly PutAppFileProviderRequest[],
  ): Promise<{ providerInstalled: boolean }> {
    this.installedDuringStage = new Set();
    await this.stageNormalized(requests);
    return { providerInstalled: this.installedDuringStage.size > 0 };
  }

  private async stageNormalized(requests: readonly PutAppFileProviderRequest[]): Promise<void> {
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
        container = await this.resolveContainer(request, true);
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

  private assertBelow(root: string, target: string, paths: typeof posix = hostPath): void {
    if (!isPathInside(root, target, { paths, allowEqual: false })) {
      throw new ActionableError(
        "iOS Files fixture destination must remain strictly below its managed namespace root.",
      );
    }
  }

  private async assertNoSymlinks(
    container: string,
    target: string,
    paths: typeof posix = hostPath,
  ): Promise<void> {
    const parts = paths.relative(container, target).split(paths.sep);
    let current = container;
    for (const part of parts) {
      current = paths.join(current, part);
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

  private async resolveContainer(
    request: Pick<PutAppFileProviderRequest, "device" | "signal">,
    mayInstall: boolean = false,
  ): Promise<string> {
    const guidance = `Install the managed iOS Files fixture app (${IOS_FILES_FIXTURE_BUNDLE_ID}) on the booted simulator and retry; no alternate storage path is used.`;
    try {
      return await this.resolveFixtureContainer(request, mayInstall);
    } catch (error) {
      if (error instanceof SimulatorContainerUnresolvedError) {
        throw new ActionableError(
          `Unable to resolve the managed iOS Files fixture container. ${guidance}`,
        );
      }
      throw toActionableError(
        error,
        `Unable to resolve the managed iOS Files fixture container. ${guidance}`,
      );
    }
  }

  /** Resolve the fixture's container; install the fixture once when a write needs it (#15404). */
  private async resolveFixtureContainer(
    request: Pick<PutAppFileProviderRequest, "device" | "signal">,
    mayInstall: boolean = true,
  ): Promise<string> {
    try {
      return await resolveOwnAppDataContainer({
        ...this.ownership,
        deviceId: request.device.deviceId,
        bundleId: IOS_FILES_FIXTURE_BUNDLE_ID,
        run: (args) =>
          this.simctlFactory(request.device).executeCommandArgs(args, 5_000, request.signal),
      });
    } catch (error) {
      // simctl exits non-zero for an app that is not installed, so a command failure is as much
      // "missing" as an empty path; an ownership refusal or a cancelled call is never fixed by it.
      if (
        !mayInstall ||
        !this.installer ||
        error instanceof SimulatorContainerOwnershipError ||
        request.signal?.aborted
      ) {
        throw error;
      }
      await this.installer.install(request.device, request.signal);
      this.installedDuringStage.add(request.device.deviceId);
      return this.resolveFixtureContainer(request, false);
    }
  }
}
