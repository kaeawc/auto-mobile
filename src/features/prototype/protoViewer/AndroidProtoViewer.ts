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
  PROTOVIEWER_MCP_COMPONENT,
  PROTOVIEWER_MCP_IMPORT_ACTION,
  PROTOVIEWER_MCP_OPEN_ACTION,
  PROTOVIEWER_PACKAGE,
  protoViewerInboxPath,
  protoViewerResultPath,
  protoViewerResultSchema,
  type ProtoViewerResult,
} from "./protoViewerContract";

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

export interface AndroidProtoViewerDependencies {
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
    const request = this.requestId();
    const inbox = protoViewerInboxPath(userId, request);
    await this.shell(`mkdir -p ${shellQuote(dirname(inbox))}`, signal);
    const temp = await this.deps.tempFiles.write(bytes);
    try {
      const pushed = await this.deps.adb.executeCommand(
        `push ${shellQuote(temp.path)} ${shellQuote(inbox)}`,
        { noRetry: true, signal },
      );
      if (outputLooksLikeShellFailure(pushed.stdout, pushed.stderr ?? "")) {
        throw new ActionableError(
          `Could not copy the prototype into ProtoViewer's inbox (${inbox}): ${output(pushed)}. Open ProtoViewer once on the device and retry.`,
        );
      }
    } finally {
      await temp.dispose();
    }
    const extras = [`--es ${PROTOVIEWER_EXTRA_REQUEST} ${request}`];
    if (label !== undefined) {
      extras.push(`--es ${PROTOVIEWER_EXTRA_LABEL} ${shellQuote(label)}`);
    }
    return await this.exchange(userId, request, PROTOVIEWER_MCP_IMPORT_ACTION, extras, {
      timeoutMs,
      signal,
      cleanup: [inbox],
    });
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
    return await this.exchange(userId, request, PROTOVIEWER_MCP_OPEN_ACTION, extras, {
      timeoutMs,
      signal,
      cleanup: [],
    });
  }

  private requestId(): string {
    // Request ids name files on the device, so keep only the characters the app accepts.
    return `mcp-${this.deps.ids.next().replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
  }

  private async exchange(
    userId: number,
    request: string,
    action: string,
    extras: readonly string[],
    options: { timeoutMs: number; signal?: AbortSignal; cleanup: readonly string[] },
  ): Promise<ProtoViewerResult> {
    const resultPath = protoViewerResultPath(userId, request);
    try {
      const started = await this.shell(
        `am start -W --user ${userId} -n ${PROTOVIEWER_MCP_COMPONENT} -a ${action} ${extras.join(" ")}`,
        options.signal,
      );
      if (startFailed(started)) {
        throw new ActionableError(startFailureMessage(started));
      }
      const result = await this.awaitResult(resultPath, options.timeoutMs, options.signal);
      if (result.request !== request) {
        throw new ActionableError(
          `ProtoViewer answered request ${result.request}, not ${request}; retry the call.`,
        );
      }
      return result;
    } finally {
      await this.removeQuietly([resultPath, ...options.cleanup], options.signal);
    }
  }

  private async awaitResult(
    path: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult> {
    const attempts = Math.max(1, Math.ceil(timeoutMs / PROTOVIEWER_RESULT_POLL_MS));
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      // The app renames a finished file into place, so a non-empty read is a whole result.
      const read = await this.shell(`cat ${shellQuote(path)} 2>/dev/null`, signal);
      const text = read.trim();
      if (text.length > 0) {
        return parseResult(text);
      }
      await this.deps.timer.sleep(PROTOVIEWER_RESULT_POLL_MS);
    }
    throw new ActionableError(
      `ProtoViewer did not answer within ${timeoutMs} ms. Unlock the device, open ProtoViewer once, and retry.`,
    );
  }

  private async removeQuietly(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    try {
      await this.shell(`rm -f ${paths.map(shellQuote).join(" ")}`, signal);
    } catch (error) {
      // Leftover inbox or result files are app-scoped and replaced or ignored on the next call.
      logger.debug(`[protoviewer] cleanup failed: ${errorMessage(error)}`);
    }
  }

  private async shell(command: string, signal?: AbortSignal): Promise<string> {
    const result = await this.deps.adb.executeCommand(`shell ${command}`, {
      noRetry: true,
      signal,
    });
    return `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
  }
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function output(result: { stdout: string; stderr?: string }): string {
  return `${result.stdout}\n${result.stderr ?? ""}`.trim();
}

function startFailed(output: string): boolean {
  return /(^|\n)\s*Error( type \d+)?:|Exception|Permission Denial/.test(output);
}

function startFailureMessage(output: string): string {
  if (/does not exist|Unable to resolve Intent/.test(output)) {
    return "This ProtoViewer build has no MCP entry point. Install a newer ProtoViewer and retry.";
  }
  return `Could not start ProtoViewer: ${output.trim()}`;
}

function parseResult(text: string): ProtoViewerResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ActionableError(`ProtoViewer wrote an unreadable result: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const parsed = protoViewerResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new ActionableError(`ProtoViewer wrote an unexpected result: ${parsed.error.message}`);
  }
  return parsed.data;
}
