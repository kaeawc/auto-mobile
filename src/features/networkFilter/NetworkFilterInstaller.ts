import path from "node:path";
import { resolveAssetVersion, resolvePinnedVersion } from "../../constants/release";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import {
  NETWORK_FILTER_APP_PATH_ENV,
  NETWORK_FILTER_INSTALL_COMMAND,
  NETWORK_FILTER_INSTALL_DIR,
  NETWORK_FILTER_TEAM_ID_ENV,
  type NetworkFilterInstallState,
  installedAppPath,
} from "./networkFilterApp";
import {
  NETWORK_FILTER_OVERRIDE_VERSION,
  NetworkFilterAppProvider,
  type NetworkFilterAppCandidate,
} from "./NetworkFilterAppProvider";
import {
  type CodeSignVerifier,
  type NetworkFilterSignatureInspection,
  DefaultCodeSignVerifier,
  signatureProblems,
} from "./NetworkFilterCodeSignVerifier";
import {
  type NetworkFilterControllerReport,
  runNetworkFilterController,
} from "./NetworkFilterController";
import { type FileInstaller, DittoFileInstaller } from "./NetworkFilterFileInstaller";
import {
  DefaultNetworkFilterCommandRunner,
  NodeNetworkFilterFileSystem,
  type NetworkFilterCommandRunner,
  type NetworkFilterFileSystem,
} from "./networkFilterHost";

export const NETWORK_FILTER_RECEIPT_FILENAME = "install-receipt.json";

/** Written next to the cache after AutoMobile confirms what is in /Applications. */
export interface NetworkFilterInstallReceipt {
  version: string;
  source: NetworkFilterAppCandidate["source"];
  sha256: string | null;
  cdhash: string | null;
  installedAt: number;
}

export type NetworkFilterInstallAction = "installed" | "upgraded" | "unchanged" | "none";

export interface NetworkFilterInstallResult {
  state: NetworkFilterInstallState;
  detail: string;
  nextSteps?: string;
  /** What happened to `/Applications`. `none` means it was left untouched. */
  action: NetworkFilterInstallAction;
  installedPath: string;
  source?: NetworkFilterAppCandidate["source"];
  version?: string;
  controllerState?: string | null;
}

/** The provider surface the installer needs. */
export interface NetworkFilterAppSource {
  ensure(): Promise<NetworkFilterAppCandidate>;
  readonly cacheDirectory: string;
}

export interface NetworkFilterInstallerDeps {
  appSource?: NetworkFilterAppSource;
  verifier?: CodeSignVerifier;
  fileInstaller?: FileInstaller;
  commandRunner?: NetworkFilterCommandRunner;
  fileSystem?: NetworkFilterFileSystem;
  timer?: Timer;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  installDir?: string;
}

function receiptPath(cacheDir: string): string {
  return path.join(cacheDir, NETWORK_FILTER_RECEIPT_FILENAME);
}

function pinnedTeamId(env: NodeJS.ProcessEnv): string | null {
  const value = env[NETWORK_FILTER_TEAM_ID_ENV]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Opt-in installer for the Network Extension app (#10588). It is only invoked
 * by the explicit `--ios-network-filter install` command: never on daemon start
 * and never as a side effect of `setDeviceState`.
 *
 * Order: fetch + checksum (provider) → `codesign` identity checks → copy to
 * `/Applications` (SystemExtensions only activates apps there) →
 * `network-filter-controller activate`. Every failure before the copy leaves
 * `/Applications` untouched. macOS approval stays a human step.
 */
export class NetworkFilterInstaller {
  private readonly appSource: NetworkFilterAppSource;
  private readonly verifier: CodeSignVerifier;
  private readonly fileInstaller: FileInstaller;
  private readonly commandRunner: NetworkFilterCommandRunner;
  private readonly fileSystem: NetworkFilterFileSystem;
  private readonly timer: Timer;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly destination: string;

  constructor(deps: NetworkFilterInstallerDeps = {}) {
    this.env = deps.env ?? process.env;
    this.commandRunner = deps.commandRunner ?? new DefaultNetworkFilterCommandRunner();
    this.fileSystem = deps.fileSystem ?? new NodeNetworkFilterFileSystem();
    this.appSource =
      deps.appSource ??
      new NetworkFilterAppProvider({
        env: this.env,
        commandRunner: this.commandRunner,
        fileSystem: this.fileSystem,
      });
    this.verifier = deps.verifier ?? new DefaultCodeSignVerifier(this.commandRunner);
    this.fileInstaller =
      deps.fileInstaller ?? new DittoFileInstaller(this.commandRunner, this.fileSystem);
    this.timer = deps.timer ?? defaultTimer;
    this.platform = deps.platform ?? process.platform;
    this.destination = installedAppPath(deps.installDir ?? NETWORK_FILTER_INSTALL_DIR);
  }

  async install(options: { upgrade?: boolean } = {}): Promise<NetworkFilterInstallResult> {
    const base = { action: "none" as const, installedPath: this.destination };
    if (this.platform !== "darwin") {
      return {
        ...base,
        state: "unavailable",
        detail: "The Network Extension app only runs on macOS hosts.",
      };
    }

    let candidate: NetworkFilterAppCandidate;
    let inspection: NetworkFilterSignatureInspection;
    try {
      candidate = await this.appSource.ensure();
      inspection = await this.verifier.inspect(candidate.appPath);
    } catch (error) {
      logger.warn(`[NETWORK_FILTER] Unable to prepare the app: ${errorMessage(error)}`, error);
      return { ...base, state: "failed", detail: errorMessage(error) };
    }
    const identity = { source: candidate.source, version: candidate.version };

    const problems = signatureProblems(inspection, pinnedTeamId(this.env));
    if (problems.length > 0) {
      return {
        ...base,
        ...identity,
        state: "failed",
        detail: `Refusing to install ${candidate.appPath}: ${problems.join("; ")}.`,
      };
    }

    let action: NetworkFilterInstallAction;
    try {
      const placed = await this.place(candidate, inspection, options.upgrade === true);
      if ("refused" in placed) {
        return { ...base, ...identity, state: "failed", ...placed.refused };
      }
      action = placed.action;
    } catch (error) {
      logger.warn(`[NETWORK_FILTER] Unable to install the app: ${errorMessage(error)}`, error);
      return { ...base, ...identity, state: "failed", detail: errorMessage(error) };
    }
    await this.writeReceipt(candidate, inspection);

    const report = await this.activate();
    return {
      ...identity,
      action,
      installedPath: this.destination,
      state: report.state,
      detail: report.detail,
      nextSteps: report.nextSteps,
      controllerState: report.controllerState,
    };
  }

  /** Decide whether the verified candidate replaces what is in /Applications. */
  private async place(
    candidate: NetworkFilterAppCandidate,
    inspection: NetworkFilterSignatureInspection,
    upgrade: boolean,
  ): Promise<
    { action: NetworkFilterInstallAction } | { refused: { detail: string; nextSteps: string } }
  > {
    if (!(await this.fileInstaller.exists(this.destination))) {
      await this.fileInstaller.install(candidate.appPath, this.destination, { replace: false });
      return { action: "installed" };
    }
    const installed = await this.verifier.inspect(this.destination);
    const identical =
      installed.app.cdhash !== null &&
      installed.app.cdhash === inspection.app.cdhash &&
      installed.app.teamIdentifier === inspection.app.teamIdentifier &&
      signatureProblems(installed, null).length === 0;
    if (identical) {
      return { action: "unchanged" };
    }
    if (!upgrade) {
      return {
        refused: {
          detail:
            `${this.destination} already exists with a different version or signature ` +
            `(installed CDHash ${installed.app.cdhash ?? "unknown"}, team ` +
            `${installed.app.teamIdentifier ?? "not set"}). It was left unchanged.`,
          nextSteps: `Run \`${NETWORK_FILTER_INSTALL_COMMAND} --upgrade\` to replace it.`,
        },
      };
    }
    await this.fileInstaller.install(candidate.appPath, this.destination, { replace: true });
    return { action: "upgraded" };
  }

  private async writeReceipt(
    candidate: NetworkFilterAppCandidate,
    inspection: NetworkFilterSignatureInspection,
  ): Promise<void> {
    const receipt: NetworkFilterInstallReceipt = {
      version: candidate.version,
      source: candidate.source,
      sha256: candidate.sha256,
      cdhash: inspection.app.cdhash,
      installedAt: this.timer.now(),
    };
    try {
      await this.fileSystem.ensureDir(this.appSource.cacheDirectory);
      await this.fileSystem.writeText(
        receiptPath(this.appSource.cacheDirectory),
        JSON.stringify(receipt, null, 2),
      );
    } catch (error) {
      // The receipt only feeds doctor's version check; activation still proceeds.
      logger.warn(
        `[NETWORK_FILTER] Unable to write the install receipt: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async activate(): Promise<NetworkFilterControllerReport> {
    try {
      return await runNetworkFilterController(this.commandRunner, this.destination, "activate");
    } catch (error) {
      logger.warn(`[NETWORK_FILTER] Activation failed: ${errorMessage(error)}`, error);
      return { state: "failed", controllerState: null, detail: errorMessage(error) };
    }
  }
}

export interface NetworkFilterHostStatus {
  installed: boolean;
  installedPath: string;
  /** Version recorded by the last install, or null when AutoMobile has no receipt. */
  installedVersion: string | null;
  expectedVersion: string;
  /** Controller `status` read-back; null when the app is not installed. */
  report: NetworkFilterControllerReport | null;
}

export interface NetworkFilterStatusInspectorDeps {
  fileSystem?: NetworkFilterFileSystem;
  commandRunner?: NetworkFilterCommandRunner;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  installDir?: string;
}

/**
 * Read-only status for doctor and the `status` command. It never downloads,
 * copies or activates; it reads the install receipt and runs the installed
 * controller's read-only `status`.
 */
export class NetworkFilterStatusInspector {
  private readonly fileSystem: NetworkFilterFileSystem;
  private readonly commandRunner: NetworkFilterCommandRunner;
  private readonly cacheDir: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly destination: string;

  constructor(deps: NetworkFilterStatusInspectorDeps = {}) {
    this.fileSystem = deps.fileSystem ?? new NodeNetworkFilterFileSystem();
    this.commandRunner = deps.commandRunner ?? new DefaultNetworkFilterCommandRunner();
    this.cacheDir = deps.cacheDir;
    this.env = deps.env ?? process.env;
    this.destination = installedAppPath(deps.installDir ?? NETWORK_FILTER_INSTALL_DIR);
  }

  async inspect(options: { timeoutMs?: number } = {}): Promise<NetworkFilterHostStatus> {
    const expectedVersion = this.env[NETWORK_FILTER_APP_PATH_ENV]?.trim()
      ? NETWORK_FILTER_OVERRIDE_VERSION
      : resolveAssetVersion(resolvePinnedVersion(this.env));
    const status: NetworkFilterHostStatus = {
      installed: false,
      installedPath: this.destination,
      installedVersion: null,
      expectedVersion,
      report: null,
    };
    if (!(await this.fileSystem.isDirectory(this.destination))) {
      return status;
    }
    const cacheDir =
      this.cacheDir ?? new NetworkFilterAppProvider({ env: this.env }).cacheDirectory;
    return {
      ...status,
      installed: true,
      installedVersion: await this.readReceiptVersion(cacheDir),
      report: await runNetworkFilterController(
        this.commandRunner,
        this.destination,
        "status",
        options.timeoutMs,
      ),
    };
  }

  private async readReceiptVersion(cacheDir: string): Promise<string | null> {
    const raw = await this.fileSystem.readText(receiptPath(cacheDir));
    if (raw === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof parsed.version === "string"
        ? parsed.version
        : null;
    } catch (error) {
      // A corrupt receipt is reported as an unknown installed version.
      logger.debug(`[NETWORK_FILTER] Ignoring unreadable install receipt: ${errorMessage(error)}`);
      return null;
    }
  }
}
