import path from "node:path";
import { resolveAssetVersion, resolvePinnedVersion } from "../../constants/release";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  NETWORK_FILTER_APP_PATH_ENV,
  NETWORK_FILTER_INSTALL_DIR,
  installedAppPath,
} from "./networkFilterApp";
import {
  NETWORK_FILTER_OVERRIDE_VERSION,
  NetworkFilterAppProvider,
} from "./NetworkFilterAppProvider";
import { runNetworkFilterController } from "./NetworkFilterController";
import {
  DefaultNetworkFilterCommandRunner,
  NodeNetworkFilterFileSystem,
  type NetworkFilterCommandRunner,
  type NetworkFilterFileSystem,
} from "./networkFilterHost";
import type {
  NetworkFilterHostStatus,
  NetworkFilterStatusInspectorDeps,
} from "./NetworkFilterInstaller";

export const NETWORK_FILTER_RECEIPT_FILENAME = "install-receipt.json";

export function receiptPath(cacheDir: string): string {
  return path.join(cacheDir, NETWORK_FILTER_RECEIPT_FILENAME);
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
