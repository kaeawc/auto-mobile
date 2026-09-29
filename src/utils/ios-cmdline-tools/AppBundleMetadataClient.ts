import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { ActionableError, type ExecResult } from "../../models";
import { runExecSeam } from "../ExecSeam";
import { execFileAsync as sharedExecFileAsync } from "../HostCommandExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import { PlistClient } from "./PlistClient";

export type PlistDictionary = Readonly<Record<string, unknown>>;

export interface EntitlementPlistReader {
  readJsonBytes(bytes: Buffer): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const UNSIGNED_BUNDLE_MARKERS = ["code object is not signed at all", "is not signed"];

export interface AppBundleMetadataRequest {
  readonly appBundlePath: string;
  readonly deviceId?: string;
  readonly bundleId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CodesignExecutor {
  execute(args: readonly string[], signal?: AbortSignal): Promise<ExecResult>;
}

export interface AppBundleMetadata {
  readEntitlements(request: AppBundleMetadataRequest): Promise<PlistDictionary | null>;
}

const defaultExecutor: CodesignExecutor = {
  async execute(args, signal) {
    const commandArgs = [...args];
    return runExecSeam(
      (options) => sharedExecFileAsync("codesign", commandArgs, options),
      { maxBuffer: 16 * 1024 * 1024, signal },
      { command: "codesign", args: commandArgs },
      { preserveError: true },
    );
  },
};

const isUnsignedBundle = (error: unknown): boolean => {
  const childError = error as { stderr?: unknown };
  const message = [
    errorMessage(error),
    typeof childError.stderr === "string" ? childError.stderr : "",
  ].join("\n");
  const normalized = message.toLowerCase();
  return UNSIGNED_BUNDLE_MARKERS.some((marker) => normalized.includes(marker));
};

const cancellationError = (): ActionableError =>
  new ActionableError("App-bundle entitlement inspection was cancelled.");

/**
 * The sole production owner of codesign for app-bundle metadata. Its structured
 * request keeps device and artifact context out of shell strings; the argv-only
 * executor receives the bundle path as one literal argument.
 */
export class AppBundleMetadataClient implements AppBundleMetadata {
  constructor(
    private readonly executor: CodesignExecutor = defaultExecutor,
    private readonly plist: EntitlementPlistReader = new PlistClient(),
    private readonly timer: Timer = defaultTimer,
  ) {}

  async readEntitlements(request: AppBundleMetadataRequest): Promise<PlistDictionary | null> {
    if (request.signal?.aborted) {
      throw cancellationError();
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      const output = await this.executeEntitlements(request, controller);
      if (request.signal?.aborted) {
        throw cancellationError();
      }
      return this.parseEntitlements(output);
    } catch (error) {
      return this.handleReadError(error, request.signal);
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private async executeEntitlements(
    request: AppBundleMetadataRequest,
    controller: AbortController,
  ): Promise<ExecResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = this.executor.execute(
      ["-d", "--entitlements", ":-", request.appBundlePath],
      controller.signal,
    );
    return await raceWithDeadline(command, {
      timer: this.timer,
      timeoutMs,
      label: "App-bundle entitlement inspection",
      timeoutError: () =>
        new ActionableError(`App-bundle entitlement inspection timed out after ${timeoutMs}ms.`),
      onTimeout: () => controller.abort(),
    });
  }

  private async parseEntitlements(output: ExecResult): Promise<PlistDictionary | null> {
    if (!output.stdout.trim()) {
      // Unsigned simulator builds may produce no entitlement plist at all.
      logger.debug("[AppBundleMetadataClient] codesign returned no app-bundle entitlements");
      return null;
    }

    try {
      const parsed = await this.plist.readJsonBytes(Buffer.from(output.stdout, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected an entitlement plist dictionary");
      }
      return parsed as PlistDictionary;
    } catch (error) {
      logger.warn(
        `[AppBundleMetadataClient] Unable to parse app-bundle entitlements: ${errorMessage(error)}`,
      );
      throw new ActionableError(
        "Unable to parse app-bundle entitlements. The signed artifact returned malformed metadata.",
      );
    }
  }

  private handleReadError(error: unknown, signal?: AbortSignal): null {
    if (signal?.aborted) {
      throw cancellationError();
    }
    if (isUnsignedBundle(error)) {
      // codesign reports unsigned simulator bundles as a failed inspection; no entitlements is a valid result.
      logger.debug("[AppBundleMetadataClient] codesign reports the app bundle is unsigned");
      return null;
    }
    if (error instanceof ActionableError) {
      throw error;
    }
    throw new ActionableError(
      "Unable to inspect app-bundle entitlements with codesign. Confirm Xcode command-line tools are installed and the artifact is accessible.",
    );
  }
}
