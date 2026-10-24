import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { isPackageInstalledForUser } from "../../../utils/android-cmdline-tools/isPackageInstalledForUser";
import { outputLooksLikeShellFailure } from "../../../utils/android-cmdline-tools/shellOutputHeuristics";
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
  PROTOVIEWER_MCP_COMPONENT,
  PROTOVIEWER_MCP_IMPORT_ACTION,
  PROTOVIEWER_MCP_OPEN_ACTION,
  PROTOVIEWER_MCP_PREPARE_ACTION,
  PROTOVIEWER_PACKAGE,
  PROTOVIEWER_REQUEST_ID,
  protoViewerInboxDir,
  protoViewerInboxPath,
  protoViewerMcpRoot,
  protoViewerResultPath,
  protoViewerResultsDir,
  protoViewerWireResultSchema,
  type ProtoViewerResult,
  type ProtoViewerWireResult,
} from "./protoViewerContract";
import { ProtoViewerEntryPointMissingError } from "./ProtoViewerEntryPointMissingError";
import { ProtoViewerStorageError } from "./ProtoViewerStorageError";

export { ProtoViewerEntryPointMissingError, ProtoViewerStorageError };

/** Host temp file holding the bundle for `adb push`; disposed after the push either way. */
export interface ProtoViewerTempFile {
  readonly path: string;
  dispose(): Promise<void>;
}
export interface ProtoViewerTempFiles {
  write(bytes: Uint8Array): Promise<ProtoViewerTempFile>;
}

/** What the saved-action router needs from a device; the adb implementation is below. */
export interface ProtoViewerDevice {
  /** The current Android user when ProtoViewer is installed for it, otherwise undefined. */
  installedUser(signal?: AbortSignal): Promise<number | undefined>;
  importBundle(
    userId: number,
    bytes: Uint8Array,
    label: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult>;
  open(
    userId: number,
    libraryId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult>;
}

export const PROTOVIEWER_RESULT_POLL_MS = 250;
export const PROTOVIEWER_DEFAULT_TIMEOUT_MS = 15_000;
/** The app only creates three folders; a longer wait means it cannot (shell-owned folders). */
export const PROTOVIEWER_PREPARE_TIMEOUT_MS = 8_000;
const PROTOVIEWER_MIN_IMPORT_WAIT_MS = 1_000;
/** Cleanup runs even after the caller's signal fired, but only this long. */
const PROTOVIEWER_CLEANUP_TIMEOUT_MS = 5_000;

interface AndroidProtoViewerDependencies {
  adb: AdbExecutor;
  timer: Timer;
  ids: IdGenerator;
  tempFiles: ProtoViewerTempFiles;
}

/**
 * Talks to ProtoViewer only through adb: push into its app-scoped inbox, start its DUMP-guarded
 * MCP activity, and read back the one result file it writes atomically (no socket, no broadcast).
 */
export class AndroidProtoViewer implements ProtoViewerDevice {
  constructor(private readonly deps: AndroidProtoViewerDependencies) {}

  async installedUser(signal?: AbortSignal): Promise<number | undefined> {
    const { userId } = await new AndroidUserTargetResolver(this.deps.adb).resolve({
      currentUser: true,
      signal,
    });
    const installed = await isPackageInstalledForUser(
      this.deps.adb,
      PROTOVIEWER_PACKAGE,
      userId,
      undefined,
      signal,
    );
    return installed ? userId : undefined;
  }

  async importBundle(
    userId: number,
    bytes: Uint8Array,
    label: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult> {
    const started = this.deps.timer.now();
    const request = this.requestId();
    const inbox = protoViewerInboxPath(userId, request);
    // The app creates the folders, never this shell: shell-owned ones are unusable to the app.
    await this.ensureStorage(userId, timeoutMs, signal);
    const temp = await this.deps.tempFiles.write(bytes);
    try {
      // argv, not a command string: a host temp path must survive Windows argument parsing.
      const pushed = await this.push(temp.path, inbox, signal);
      if (outputLooksLikeShellFailure(pushed.stdout, pushed.stderr ?? "")) {
        throw new ProtoViewerStorageError(
          `Could not copy the prototype into ProtoViewer's inbox (${inbox}): ${output(pushed)}.`,
        );
      }
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
    const result = await this.work(userId, request, PROTOVIEWER_MCP_IMPORT_ACTION, extras, {
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
    userId: number,
    libraryId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult> {
    const request = this.requestId();
    const extras = [
      `--es ${PROTOVIEWER_EXTRA_REQUEST} ${request}`,
      `--es ${PROTOVIEWER_EXTRA_LIBRARY_ID} ${shellQuote(libraryId)}`,
    ];
    return await this.work(userId, request, PROTOVIEWER_MCP_OPEN_ACTION, extras, {
      timeoutMs,
      signal,
      cleanup: [],
    });
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
    userId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.storageReady(userId, signal)) {
      return;
    }
    // A folder an earlier adb session made is shell-owned and unusable to the app; the shell can
    // remove what it owns, after which the app creates it.
    await this.removeShellOwnedFolders(userId, signal);
    const request = this.requestId();
    try {
      const prepared = await this.exchange(
        userId,
        request,
        PROTOVIEWER_MCP_PREPARE_ACTION,
        [`--es ${PROTOVIEWER_EXTRA_REQUEST} ${request}`],
        {
          timeoutMs: Math.min(timeoutMs, PROTOVIEWER_PREPARE_TIMEOUT_MS),
          signal,
          cleanup: [],
        },
      );
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
    if (!(await this.storageReady(userId, signal))) {
      throw new ProtoViewerStorageError(
        "ProtoViewer reported its inbox ready, but the folders are not there.",
      );
    }
  }

  private async storageReady(userId: number, signal?: AbortSignal): Promise<boolean> {
    const root = shellQuote(protoViewerMcpRoot(userId));
    const inbox = shellQuote(protoViewerInboxDir(userId));
    const results = shellQuote(protoViewerResultsDir(userId));
    // Ready means present and not owned by the shell (`-O`: owned by the caller, here the shell).
    // `if` keeps the exit status 0 either way: adb reports a failing remote command as an error.
    const probe = await this.shell(
      `if [ -d ${inbox} ] && [ -d ${results} ] && [ ! -O ${root} ] && [ ! -O ${inbox} ] && [ ! -O ${results} ]; then echo ready; fi`,
      signal,
    );
    return probe.includes("ready");
  }

  private async removeShellOwnedFolders(userId: number, signal?: AbortSignal): Promise<void> {
    const folders = [
      protoViewerMcpRoot(userId),
      protoViewerInboxDir(userId),
      protoViewerResultsDir(userId),
    ].map(shellQuote);
    await this.shell(
      `for d in ${folders.join(" ")}; do if [ -O "$d" ]; then rm -rf "$d"; fi; done`,
      signal,
    );
  }

  private async work(
    userId: number,
    request: string,
    action: string,
    extras: readonly string[],
    options: { timeoutMs: number; signal?: AbortSignal; cleanup: readonly string[] },
  ): Promise<ProtoViewerResult> {
    const result = await this.exchange(userId, request, action, extras, options);
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
    userId: number,
    request: string,
    action: string,
    extras: readonly string[],
    options: { timeoutMs: number; signal?: AbortSignal; cleanup: readonly string[] },
  ): Promise<ProtoViewerWireResult> {
    const resultPath = protoViewerResultPath(userId, request);
    try {
      // A new task per call: without it a second launch while one runs only brings the first
      // to the front (same component and intent filter), and that request is never handled.
      const started = await this.shell(
        `am start -W --activity-multiple-task --user ${userId} -n ${PROTOVIEWER_MCP_COMPONENT} -a ${action} ${extras.join(" ")}`,
        options.signal,
      );
      throwIfStartFailed(started);
      const result = await this.awaitResult(resultPath, options.timeoutMs, options.signal);
      if (result.request !== request) {
        throw new ActionableError(
          `ProtoViewer answered request ${result.request}, not ${request}; retry the call.`,
        );
      }
      return result;
    } finally {
      await this.removeQuietly([resultPath, ...options.cleanup]);
    }
  }

  private async awaitResult(
    path: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerWireResult> {
    // A deadline, not an attempt count: each read is an adb round trip of its own.
    const deadline = this.deps.timer.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      // The app renames a finished file into place, so a non-empty read is a whole result. A bare
      // `cat` of a file that is not there yet exits 1, which adb turns into a thrown error and the
      // call would fail on its first poll (#15174); `if` keeps "not yet" an empty read.
      const read = await this.shell(
        `if [ -f ${shellQuote(path)} ]; then cat ${shellQuote(path)}; fi`,
        signal,
      );
      const text = read.trim();
      if (text.length > 0) {
        return parseResult(text);
      }
      await this.deps.timer.sleep(PROTOVIEWER_RESULT_POLL_MS);
    } while (this.deps.timer.now() < deadline);
    throw new ActionableError(
      `ProtoViewer did not answer within ${timeoutMs} ms. It may still have saved the prototype: check ProtoViewer before retrying, and unlock the device if it is locked.`,
    );
  }

  /** Runs without the caller's signal, so a cancelled call still removes its own files. */
  private async removeQuietly(paths: readonly string[]): Promise<void> {
    try {
      await this.shell(`rm -f ${paths.map(shellQuote).join(" ")}`, undefined, {
        timeoutMs: PROTOVIEWER_CLEANUP_TIMEOUT_MS,
      });
    } catch (error) {
      // Best effort: a leftover file only takes app-scoped space, and uninstalling removes it.
      logger.warn(`[protoviewer] cleanup of ${paths.join(", ")} failed: ${errorMessage(error)}`);
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

function parseResult(text: string): ProtoViewerWireResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ActionableError(`ProtoViewer wrote an unreadable result: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const parsed = protoViewerWireResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new ActionableError(`ProtoViewer wrote an unexpected result: ${parsed.error.message}`);
  }
  return parsed.data;
}
