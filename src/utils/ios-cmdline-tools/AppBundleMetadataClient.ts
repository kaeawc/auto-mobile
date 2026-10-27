import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { ActionableError, type ExecResult } from "../../models";
import { runExecSeam } from "../ExecSeam";
import { execFileAsync as sharedExecFileAsync } from "../HostCommandExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import { PlistClient } from "./PlistClient";
import { parseCodesignDisplay, type CodeSignature } from "./codesignDisplay";

export type PlistDictionary = Readonly<Record<string, unknown>>;

export interface EntitlementPlistReader {
  readJsonBytes(bytes: Buffer): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const ENTITLEMENTS_LABEL = "App-bundle entitlement inspection";
const SIGNATURE_LABEL = "App-bundle code-signature inspection";
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

/** The signature summary of an on-disk bundle (#14099). */
export interface CodeSignatureReader {
  /** Null when the bundle is unsigned. */
  readCodeSignature(request: AppBundleMetadataRequest): Promise<CodeSignature | null>;
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

const cancellationError = (label = "App-bundle entitlement inspection"): ActionableError =>
  new ActionableError(`${label} was cancelled.`);

/**
 * The sole production owner of codesign for app-bundle metadata. Its structured
 * request keeps device and artifact context out of shell strings; the argv-only
 * executor receives the bundle path as one literal argument.
 */
export class AppBundleMetadataClient implements AppBundleMetadata, CodeSignatureReader {
  constructor(
    private readonly executor: CodesignExecutor = defaultExecutor,
    private readonly plist: EntitlementPlistReader = new PlistClient(),
    private readonly timer: Timer = defaultTimer,
  ) {}

  async readEntitlements(request: AppBundleMetadataRequest): Promise<PlistDictionary | null> {
    const output = await this.run(
      ["-d", "--entitlements", ":-", request.appBundlePath],
      request,
      ENTITLEMENTS_LABEL,
    );
    return output ? this.parseEntitlements(output) : null;
  }

  /**
   * `codesign -dvvv <bundle>`: identifier, team, certificate chain and CDHash. codesign prints the
   * display on stderr; an unsigned bundle reads as null, like `readEntitlements`.
   */
  async readCodeSignature(request: AppBundleMetadataRequest): Promise<CodeSignature | null> {
    const output = await this.run(["-d", "-vvv", request.appBundlePath], request, SIGNATURE_LABEL);
    return output ? parseCodesignDisplay(`${output.stderr}\n${output.stdout}`) : null;
  }

  /** Run one bounded, cancellable codesign read; null when codesign reports an unsigned bundle. */
  private async run(
    args: readonly string[],
    request: AppBundleMetadataRequest,
    label: string,
  ): Promise<ExecResult | null> {
    if (request.signal?.aborted) {
      throw cancellationError(label);
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      const output = await this.execute(args, request, controller, label);
      if (request.signal?.aborted) {
        throw cancellationError(label);
      }
      return output;
    } catch (error) {
      return this.handleReadError(error, label, request.signal);
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private async execute(
    args: readonly string[],
    request: AppBundleMetadataRequest,
    controller: AbortController,
    label: string,
  ): Promise<ExecResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = this.executor.execute(args, controller.signal);
    return await raceWithDeadline(command, {
      timer: this.timer,
      timeoutMs,
      label,
      timeoutError: () => new ActionableError(`${label} timed out after ${timeoutMs}ms.`),
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

  private handleReadError(error: unknown, label: string, signal?: AbortSignal): null {
    if (signal?.aborted) {
      throw cancellationError(label);
    }
    if (isUnsignedBundle(error)) {
      // codesign reports unsigned simulator bundles as a failed inspection; no signature is a valid result.
      logger.debug(
        `[AppBundleMetadataClient] codesign reports the app bundle is unsigned (${label})`,
      );
      return null;
    }
    if (error instanceof ActionableError) {
      throw error;
    }
    throw new ActionableError(
      `${label} with codesign failed. Confirm Xcode command-line tools are installed and the artifact is accessible.`,
    );
  }
}
