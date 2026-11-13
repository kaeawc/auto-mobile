import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import {
  outputLooksLikeShellFailure,
  packageListingContains,
} from "../../../utils/android-cmdline-tools/shellOutputHeuristics";
import type { IdGenerator } from "../../../utils/IdGenerator";
import type { Timer } from "../../../utils/SystemTimer";
import { shellQuote } from "../../../utils/shellQuote";
import { ActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import {
  PROTOVIEWER_EXTRA_LABEL,
  PROTOVIEWER_EXTRA_LIBRARY_ID,
  PROTOVIEWER_EXTRA_REQUEST,
  PROTOVIEWER_INBOX_PATH,
  PROTOVIEWER_MCP_IMPORT_ACTION,
  PROTOVIEWER_MCP_OPEN_ACTION,
  PROTOVIEWER_MCP_PREPARE_ACTION,
  PROTOVIEWER_PLAY_STORE_URL,
  PROTOVIEWER_REQUEST_ID,
  preferredProtoViewerPackage,
  protoViewerCapabilitiesPath,
  parseProtoViewerCapabilities,
  protoViewerProviderUri,
  protoViewerProviderCommand,
  protoViewerProviderWriteCommand,
  protoViewerStagingPath,
  type ProtoViewerCapabilitiesFile,
  protoViewerInboxDir,
  protoViewerInboxPath,
  protoViewerMcpComponent,
  protoViewerMcpRoot,
  protoViewerResultPath,
  protoViewerResultsDir,
  type ProtoViewerPackage,
  type ProtoViewerResult,
  type ProtoViewerWireResult,
} from "./protoViewerContract";
import { ProtoViewerEntryPointMissingError } from "./ProtoViewerEntryPointMissingError";
import { ProtoViewerStorageError } from "./ProtoViewerStorageError";

import {
  type ProtoViewerCapabilityOptions,
  type ProtoViewerCapabilityReport,
  type ProtoViewerDevice,
  type ProtoViewerTempFiles,
  PROTOVIEWER_CLEANUP_TIMEOUT_MS,
} from "./protoViewerDevice";
import { getAndroidAppMetadataFromAdb } from "../../observe/GetAppMetadata";
import { pollProtoViewerResult } from "./pollProtoViewerResult";

/** The app only creates three folders; a longer wait means it cannot (shell-owned folders). */
export const PROTOVIEWER_PREPARE_TIMEOUT_MS = 8_000;
const PROTOVIEWER_MIN_IMPORT_WAIT_MS = 1_000;
interface AndroidProtoViewerDependencies {
  adb: AdbExecutor;
  timer: Timer;
  ids: IdGenerator;
  tempFiles: ProtoViewerTempFiles;
  /** App IDs to drive, in preference order; defaults to the `.dev` build, then the store build. */
  appIds?: readonly ProtoViewerPackage[];
}

/** The Android user and the installed ProtoViewer build (store or `.dev`) this host drives. */
interface ProtoViewerTarget {
  readonly userId: number;
  readonly appId: ProtoViewerPackage;
}

/** One ProtoViewer intent: its extras, how long to wait for the result, and files to remove after. */
interface ProtoViewerExchangeOptions {
  extras: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
  cleanup: readonly string[];
}

/**
 * Talks to ProtoViewer only through adb: push into its app-scoped inbox, start its DUMP-guarded
 * MCP activity, and read back the one result file it writes atomically (no socket, no broadcast).
 */
export class AndroidProtoViewer implements ProtoViewerDevice {
  private target: ProtoViewerTarget | undefined;

  constructor(private readonly deps: AndroidProtoViewerDependencies) {}

  async installed(signal?: AbortSignal): Promise<boolean> {
    const { userId } = await new AndroidUserTargetResolver(this.deps.adb).resolve({
      currentUser: true,
      signal,
    });
    // One listing for both app IDs; it excludes retained (uninstalled) packages.
    const listing = await this.deps.adb.executeCommand(`shell pm list packages --user ${userId}`, {
      noRetry: true,
      signal,
    });
    const appId = preferredProtoViewerPackage(
      (id) => packageListingContains(listing.stdout, id),
      this.deps.appIds,
    );
    this.target = appId === undefined ? undefined : { userId, appId };
    return this.target !== undefined;
  }

  /**
   * Reads the report the app publishes in `mcp/capabilities.json` (#14156). The app rewrites it on
   * every start and PREPARE, so a report for another versionCode (an update the app has not run
   * since) or a refresh request sends PREPARE first. A missing report while the folders were already
   * there means a build from before the handshake: undefined, without another round trip.
   */
  async capabilities({
    timeoutMs,
    refresh,
    signal,
  }: ProtoViewerCapabilityOptions): Promise<ProtoViewerCapabilityReport | undefined> {
    const target = await this.requireTarget(signal);
    if (target.userId !== 0) {
      // A secondary user's MCP storage is reachable only through the app's provider, which serves
      // inbox writes and result reads, not the report. Unknown: the app still refuses an
      // unsupported spec on import (the `capability` result path).
      return undefined;
    }
    await this.ensureStorage(target, timeoutMs, signal);
    const installed = await this.installedVersionCode(target, signal);
    let published = await this.readCapabilities(target, signal);
    const stale =
      published !== undefined && installed !== undefined && published.versionCode !== installed;
    if (refresh || stale) {
      await this.prepare(target, timeoutMs, signal);
      published = await this.readCapabilities(target, signal);
    }
    if (
      published === undefined ||
      (installed !== undefined && published.versionCode !== installed)
    ) {
      return undefined;
    }
    return {
      ...(published.versionName ? { version: published.versionName } : {}),
      capabilities: new Set(published.capabilities),
      updateUrl: PROTOVIEWER_PLAY_STORE_URL,
    };
  }

  /** Undefined when dumpsys does not say; the report is then taken as is. */
  private async installedVersionCode(
    target: ProtoViewerTarget,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const metadata = await getAndroidAppMetadataFromAdb(this.deps.adb, target.appId, {
      signal,
      optional: true,
    });
    const code = metadata?.buildNumber ? Number(metadata.buildNumber) : Number.NaN;
    return Number.isSafeInteger(code) ? code : undefined;
  }

  private async readCapabilities(
    target: ProtoViewerTarget,
    signal?: AbortSignal,
  ): Promise<ProtoViewerCapabilitiesFile | undefined> {
    const path = shellQuote(protoViewerCapabilitiesPath(target.userId, target.appId));
    // `if` keeps the exit status 0 when the file is missing (a bare cat exits 1, #15174).
    const text = (await this.shell(`if [ -f ${path} ]; then cat ${path}; fi`, signal)).trim();
    if (text === "") {
      return undefined;
    }
    return parseProtoViewerCapabilities(text);
  }

  async importBundle(
    bytes: Uint8Array,
    label: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult> {
    const target = await this.requireTarget(signal);
    const started = this.deps.timer.now();
    const request = this.requestId();
    const inbox =
      target.userId === 0
        ? protoViewerInboxPath(target.userId, target.appId, request)
        : protoViewerProviderUri(target.appId, "inbox", request);
    // The app creates the folders, never this shell: shell-owned ones are unusable to the app.
    if (target.userId === 0) {
      await this.ensureStorage(target, timeoutMs, signal);
    }
    const temp = await this.deps.tempFiles.write(bytes);
    try {
      // argv, not a command string: a host temp path must survive Windows argument parsing.
      const destination = target.userId === 0 ? inbox : protoViewerStagingPath(request);
      const pushed = await this.push(temp.path, destination, signal);
      if (outputLooksLikeShellFailure(pushed.stdout, pushed.stderr ?? "")) {
        throw new ProtoViewerStorageError(
          `Could not copy the prototype into ProtoViewer's inbox (${inbox}): ${output(pushed)}.`,
        );
      }
      if (target.userId !== 0) {
        await this.providerShell(
          protoViewerProviderWriteCommand(target.userId, inbox, destination),
          signal,
        );
      }
    } catch (error) {
      if (target.userId !== 0) {
        // The write command removes the staging copy only when it runs; a cancelled or failed
        // push/write would otherwise leave it in /data/local/tmp, outside the app's sweep.
        await this.removeStagingQuietly(protoViewerStagingPath(request));
      }
      throw error;
    } finally {
      await temp.dispose();
    }
    const extras = [`--es ${PROTOVIEWER_EXTRA_REQUEST} ${request}`];
    if (label !== undefined) {
      extras.push(`--es ${PROTOVIEWER_EXTRA_LABEL} ${shellQuote(label)}`);
    }
    // Preparing storage spends part of the caller's budget; the import gets what is left.
    const remainingMs = Math.max(
      timeoutMs - (this.deps.timer.now() - started),
      Math.min(timeoutMs, PROTOVIEWER_MIN_IMPORT_WAIT_MS),
    );
    const result = await this.work(target, request, PROTOVIEWER_MCP_IMPORT_ACTION, {
      extras,
      timeoutMs: remainingMs,
      signal,
      cleanup: [inbox],
    });
    if (result.status === "rejected" && result.path === PROTOVIEWER_INBOX_PATH) {
      // The app answered, so it is up, but it cannot see (or read) what the shell pushed.
      throw new ProtoViewerStorageError(
        `ProtoViewer cannot read the prototype pushed into its inbox: ${result.reason}.`,
      );
    }
    return result;
  }

  async open(
    libraryId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult> {
    const target = await this.requireTarget(signal);
    const request = this.requestId();
    const extras = [
      `--es ${PROTOVIEWER_EXTRA_REQUEST} ${request}`,
      `--es ${PROTOVIEWER_EXTRA_LIBRARY_ID} ${shellQuote(libraryId)}`,
    ];
    return await this.work(target, request, PROTOVIEWER_MCP_OPEN_ACTION, {
      extras,
      timeoutMs,
      signal,
      cleanup: [],
    });
  }

  private async requireTarget(signal?: AbortSignal): Promise<ProtoViewerTarget> {
    if (this.target === undefined && !(await this.installed(signal))) {
      throw new ActionableError("ProtoViewer is not installed for the current Android user.");
    }
    return this.target!;
  }

  /** adb exits non-zero when the device refuses the push, which the executor throws. */
  private async push(from: string, to: string, signal?: AbortSignal) {
    try {
      return await this.deps.adb.execute(["push", from, to], { noRetry: true, signal });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ProtoViewerStorageError(
        `Could not copy the prototype into ProtoViewer's inbox (${to}): ${errorMessage(error)}.`,
        { cause: error },
      );
    }
  }

  /**
   * Has the app create `mcp/inbox` and `mcp/results` when they are missing. A cold app answers
   * within a second or two; no answer means it cannot create them, so the push would be unreadable.
   */
  private async ensureStorage(
    target: ProtoViewerTarget,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.storageReady(target, signal)) {
      return;
    }
    // A folder an earlier adb session made is shell-owned and unusable to the app; the shell can
    // remove what it owns, after which the app creates it.
    await this.removeShellOwnedFolders(target, signal);
    await this.prepare(target, timeoutMs, signal);
    if (!(await this.storageReady(target, signal))) {
      throw new ProtoViewerStorageError(
        "ProtoViewer reported its inbox ready, but the folders are not there.",
      );
    }
  }

  /** PREPARE: the app creates its folders and republishes its capabilities report. */
  private async prepare(
    target: ProtoViewerTarget,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = this.requestId();
    try {
      const prepared = await this.exchange(target, request, PROTOVIEWER_MCP_PREPARE_ACTION, {
        extras: [`--es ${PROTOVIEWER_EXTRA_REQUEST} ${request}`],
        timeoutMs: Math.min(timeoutMs, PROTOVIEWER_PREPARE_TIMEOUT_MS),
        signal,
        cleanup: [],
      });
      if (prepared.status !== "prepared") {
        throw new ActionableError(
          `ProtoViewer answered a prepare request with ${prepared.status}.`,
        );
      }
    } catch (error) {
      if (signal?.aborted || error instanceof ProtoViewerEntryPointMissingError) {
        throw error;
      }
      throw new ProtoViewerStorageError(
        `ProtoViewer could not prepare its inbox (${errorMessage(error)}).`,
        { cause: error },
      );
    }
  }

  private async storageReady(target: ProtoViewerTarget, signal?: AbortSignal): Promise<boolean> {
    const root = shellQuote(protoViewerMcpRoot(target.userId, target.appId));
    const inbox = shellQuote(protoViewerInboxDir(target.userId, target.appId));
    const results = shellQuote(protoViewerResultsDir(target.userId, target.appId));
    // Ready means present and not owned by the shell (`-O`: owned by the caller, here the shell).
    // `if` keeps the exit status 0 either way: adb reports a failing remote command as an error.
    const probe = await this.shell(
      `if [ -d ${inbox} ] && [ -d ${results} ] && [ ! -O ${root} ] && [ ! -O ${inbox} ] && [ ! -O ${results} ]; then echo ready; fi`,
      signal,
    );
    return probe.includes("ready");
  }

  private async removeShellOwnedFolders(
    target: ProtoViewerTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    const folders = [
      protoViewerMcpRoot(target.userId, target.appId),
      protoViewerInboxDir(target.userId, target.appId),
      protoViewerResultsDir(target.userId, target.appId),
    ].map(shellQuote);
    await this.shell(
      `for d in ${folders.join(" ")}; do if [ -O "$d" ]; then rm -rf "$d"; fi; done`,
      signal,
    );
  }

  private async work(
    target: ProtoViewerTarget,
    request: string,
    action: string,
    options: ProtoViewerExchangeOptions,
  ): Promise<ProtoViewerResult> {
    const result = await this.exchange(target, request, action, options);
    if (result.status === "prepared") {
      throw new ActionableError("ProtoViewer answered a request with a prepare result; retry.");
    }
    return result;
  }

  private requestId(): string {
    // Request ids name files on the device, so keep only the characters the app accepts.
    const request = `mcp-${this.deps.ids.next().replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
    if (!PROTOVIEWER_REQUEST_ID.test(request)) {
      throw new ActionableError(`Generated an unusable ProtoViewer request id: ${request}`);
    }
    return request;
  }

  private async exchange(
    target: ProtoViewerTarget,
    request: string,
    action: string,
    { extras, ...options }: ProtoViewerExchangeOptions,
  ): Promise<ProtoViewerWireResult> {
    const resultPath =
      target.userId === 0
        ? protoViewerResultPath(target.userId, target.appId, request)
        : protoViewerProviderUri(target.appId, "results", request);
    try {
      // A new task per call: without it a second launch while one runs only brings the first
      // to the front (same component and intent filter), and that request is never handled.
      const started = await this.shell(
        `am start -W --activity-multiple-task --user ${target.userId} -n ${protoViewerMcpComponent(target.appId)} -a ${action} ${extras.join(" ")}`,
        options.signal,
      );
      throwIfStartFailed(started);
      const result = await pollProtoViewerResult(
        () =>
          target.userId === 0
            ? this.shell(
                `if [ -f ${shellQuote(resultPath)} ]; then cat ${shellQuote(resultPath)}; fi`,
                options.signal,
              )
            : this.providerShell(
                protoViewerProviderCommand("read", target.userId, resultPath),
                options.signal,
              ),
        this.deps.timer,
        options.timeoutMs,
        { signal: options.signal },
      );
      if (result.request !== request) {
        throw new ActionableError(
          `ProtoViewer answered request ${result.request}, not ${request}; retry the call.`,
        );
      }
      return result;
    } finally {
      await this.removeQuietly(target, [resultPath, ...options.cleanup]);
    }
  }

  /** Runs without the caller's signal, so a cancelled call still removes its own files. */
  private async removeQuietly(target: ProtoViewerTarget, paths: readonly string[]): Promise<void> {
    try {
      const command =
        target.userId === 0
          ? `rm -f ${paths.map(shellQuote).join(" ")}`
          : paths.map((uri) => protoViewerProviderCommand("delete", target.userId, uri)).join("; ");
      await this.shell(command, undefined, {
        timeoutMs: PROTOVIEWER_CLEANUP_TIMEOUT_MS,
      });
    } catch (error) {
      // Best effort: a leftover file only takes app-scoped space, and uninstalling removes it.
      logger.warn(`[protoviewer] cleanup of ${paths.join(", ")} failed: ${errorMessage(error)}`);
    }
  }

  /** Runs without the caller's signal, so a cancelled save still removes its staging copy. */
  private async removeStagingQuietly(staging: string): Promise<void> {
    try {
      await this.shell(`rm -f ${shellQuote(staging)}`, undefined, {
        timeoutMs: PROTOVIEWER_CLEANUP_TIMEOUT_MS,
      });
    } catch (error) {
      // Best effort: the import already failed, and that error is what the caller needs.
      logger.warn(`[protoviewer] cleanup of ${staging} failed: ${errorMessage(error)}`);
    }
  }

  private async providerShell(command: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.shell(command, signal);
      // Result JSON can contain labels or rejection reasons such as "Error: ...".
      if (!result.trimStart().startsWith("{") && outputLooksLikeShellFailure(result, "")) {
        throw new ProtoViewerStorageError(
          `Could not access ProtoViewer's MCP storage: ${result.trim()}.`,
        );
      }
      return result;
    } catch (error) {
      if (signal?.aborted || error instanceof ProtoViewerStorageError) {
        throw error;
      }
      throw new ProtoViewerStorageError(
        `Could not access ProtoViewer's MCP storage: ${errorMessage(error)}.`,
        { cause: error },
      );
    }
  }

  private async shell(
    command: string,
    signal?: AbortSignal,
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    const result = await this.deps.adb.executeCommand(`shell ${command}`, {
      noRetry: true,
      signal,
      ...options,
    });
    return `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
  }
}

function output(result: { stdout: string; stderr?: string }): string {
  return `${result.stdout}\n${result.stderr ?? ""}`.trim();
}

function throwIfStartFailed(output: string): void {
  if (/does not exist|Unable to resolve Intent/.test(output)) {
    throw new ProtoViewerEntryPointMissingError();
  }
  // "Activity not started" means the request was dropped: nothing would ever answer it.
  if (/(^|\n)\s*Error( type \d+)?:|Exception|Permission Denial|Activity not started/.test(output)) {
    throw new ActionableError(`Could not start ProtoViewer: ${output.trim()}`);
  }
}
