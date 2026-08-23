import { DefaultHostCommandExecutor, type HostCommandExecutor } from "./HostCommandExecutor";
import { logger } from "./logger";

/**
 * The macOS host `defaults` binary. This client is the single production owner
 * that resolves and executes it for host-only reads (issue #4062). Simulator
 * `defaults` commands run inside a booted simulator via `xcrun simctl spawn` and
 * belong to `SimCtlClient`; they are intentionally not routed through here.
 */
const DEFAULTS_BINARY = "defaults";
const GLOBAL_DOMAIN_FLAG = "-g";

/** `defaults read` is a trivial host lookup; keep the ceiling short. */
const DEFAULT_READ_TIMEOUT_MS = 2000;

export interface HostDefaultsReadOptions {
  /** Override the read timeout. Defaults to {@link DEFAULT_READ_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Cancellation signal propagated to the underlying exec seam. */
  signal?: AbortSignal;
}

/**
 * Host-only reads of the macOS `defaults` CLI. Returns the trimmed scalar value,
 * or `null` when the key is unset, the value is empty, the CLI is absent, or the
 * host is not macOS. Callers treat `null` as "unknown" and fall back.
 */
export interface HostDefaultsClient {
  /** Whether host `defaults` is available on this platform (macOS only). */
  isSupported(): boolean;
  /** Read a key from the global (`-g`) domain. */
  readGlobal(key: string, options?: HostDefaultsReadOptions): Promise<string | null>;
}

export interface HostDefaultsClientDependencies {
  executor: HostCommandExecutor;
  platform: NodeJS.Platform;
  logger: Pick<typeof logger, "debug">;
}

function defaultDependencies(): HostDefaultsClientDependencies {
  return {
    executor: new DefaultHostCommandExecutor(),
    platform: process.platform,
    logger,
  };
}

export class DefaultHostDefaultsClient implements HostDefaultsClient {
  constructor(
    private readonly dependencies: HostDefaultsClientDependencies = defaultDependencies(),
  ) {}

  isSupported(): boolean {
    return this.dependencies.platform === "darwin";
  }

  async readGlobal(key: string, options: HostDefaultsReadOptions = {}): Promise<string | null> {
    if (!this.isSupported()) {
      return null;
    }

    try {
      const result = await this.dependencies.executor.executeCommand(
        DEFAULTS_BINARY,
        ["read", GLOBAL_DOMAIN_FLAG, key],
        {
          timeoutMs: options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
          signal: options.signal,
        },
      );
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    } catch (error) {
      // `defaults read -g <key>` exits non-zero when the key has never been set
      // (e.g. no AppleInterfaceStyle in light mode) or the CLI is missing. Both
      // mean "unknown", so null lets callers fall back to their default.
      this.dependencies.logger.debug(`host defaults read -g ${key} failed: ${error}`, error);
      return null;
    }
  }
}
