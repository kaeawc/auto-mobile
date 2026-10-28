import { join } from "node:path";
import { ActionableError } from "../../../models/ActionableError";
import type { Timer } from "../../../utils/SystemTimer";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { SimctlCommandTimeoutError } from "../../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import {
  PROTOVIEWER_CLEANUP_TIMEOUT_MS,
  ProtoViewerEntryPointMissingError,
  ProtoViewerForegroundError,
  ProtoViewerStorageError,
  type ProtoViewerDevice,
} from "./protoViewerDevice";
import {
  PROTOVIEWER_IOS_MCP_FOLDER,
  PROTOVIEWER_INBOX_FOLDER,
  PROTOVIEWER_RESULTS_FOLDER,
  PROTOVIEWER_REQUEST_ID,
  protoViewerIosImportUrl,
  protoViewerIosOpenUrl,
  type ProtoViewerResult,
} from "./protoViewerContract";
import { pollProtoViewerResult } from "./pollProtoViewerResult";
/** A cold launch may use most of the budget; the result still gets this long (as on Android). */
const PROTOVIEWER_MIN_RESULT_WAIT_MS = 1_000;

export interface IosProtoViewerSimctl {
  installed(udid: string, signal?: AbortSignal): Promise<boolean>;
  dataContainer(udid: string, signal?: AbortSignal): Promise<string>;
  /**
   * Brings ProtoViewer to the foreground (`simctl launch`). iOS asks "Open in ProtoViewer?" when a URL
   * is opened while the app is in the background, and nothing answers that alert (#15435).
   */
  launch(udid: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  /** Resolves only on exit zero; rejects for non-delivery or a typed command timeout. */
  openurl(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<void>;
}
export interface IosProtoViewerFiles {
  mkdir(path: string): Promise<void>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Missing is pending; other read errors must propagate. */
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}
interface Dependencies {
  deviceId: string;
  simctl: IosProtoViewerSimctl;
  files: IosProtoViewerFiles;
  timer: Timer;
  ids: IdGenerator;
}
/** Simulator filesystem inbox and URL delivery; physical devices retain the template path. */
export class IosProtoViewer implements ProtoViewerDevice {
  constructor(private readonly deps: Dependencies) {}
  async installed(signal?: AbortSignal): Promise<boolean> {
    return (
      resolveIosDeviceKind(this.deps) === "simulator" &&
      (await this.deps.simctl.installed(this.deps.deviceId, signal))
    );
  }
  importBundle(
    bytes: Uint8Array,
    label: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult> {
    return this.exchange(timeoutMs, signal, { bytes, label });
  }
  open(libraryId: string, timeoutMs: number, signal?: AbortSignal): Promise<ProtoViewerResult> {
    return this.exchange(timeoutMs, signal, { libraryId });
  }
  private async exchange(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    work: { bytes: Uint8Array; label?: string } | { libraryId: string },
  ): Promise<ProtoViewerResult> {
    signal?.throwIfAborted();
    const started = this.deps.timer.now();
    const request = `mcp-${this.deps.ids.next().replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
    if (!PROTOVIEWER_REQUEST_ID.test(request)) {
      throw new ActionableError("Generated an unusable ProtoViewer request id.");
    }
    const container = await this.deps.simctl.dataContainer(this.deps.deviceId, signal);
    if (!container.trim()) {
      throw new ProtoViewerStorageError("Could not resolve ProtoViewer's data container.");
    }
    const root = join(container, PROTOVIEWER_IOS_MCP_FOLDER);
    const inboxDir = join(root, PROTOVIEWER_INBOX_FOLDER);
    const resultsDir = join(root, PROTOVIEWER_RESULTS_FOLDER);
    const inbox = join(inboxDir, `${request}.automobile-proto`);
    const temporary = `${inbox}.tmp`;
    const resultPath = join(resultsDir, `${request}.json`);
    try {
      await this.prepare(inboxDir, resultsDir, temporary, inbox, work, signal);
      signal?.throwIfAborted();
      const url =
        "bytes" in work
          ? protoViewerIosImportUrl(request, work.label)
          : protoViewerIosOpenUrl(request, work.libraryId);
      await this.foreground(timeoutMs, signal);
      await this.deliver(url, timeoutMs, signal);
      // One budget for delivery and polling, so a slow cold launch cannot double the wait.
      const pollMs = Math.max(
        timeoutMs - (this.deps.timer.now() - started),
        Math.min(timeoutMs, PROTOVIEWER_MIN_RESULT_WAIT_MS),
      );
      const result = await pollProtoViewerResult(
        () => this.deps.files.read(resultPath),
        this.deps.timer,
        pollMs,
        signal,
      );
      if (result.request !== request) {
        throw new ActionableError(
          `ProtoViewer answered request ${result.request}, not ${request}; retry the call.`,
        );
      }
      if (result.status === "prepared") {
        throw new ActionableError("ProtoViewer answered a request with a prepare result; retry.");
      }
      if (result.status === "rejected" && result.path === "inbox") {
        throw new ProtoViewerStorageError(
          `ProtoViewer cannot read the prototype pushed into its inbox: ${result.reason}.`,
        );
      }
      return result;
    } finally {
      await this.cleanup([resultPath, inbox, temporary]);
    }
  }

  private async prepare(
    inboxDir: string,
    resultsDir: string,
    temporary: string,
    inbox: string,
    work: { bytes: Uint8Array } | { libraryId: string },
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.files.mkdir(inboxDir);
      await this.deps.files.mkdir(resultsDir);
      if ("bytes" in work) {
        await this.deps.files.write(temporary, work.bytes);
        await this.deps.files.rename(temporary, inbox);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ProtoViewerStorageError(
        `Could not prepare ProtoViewer's inbox: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /** Require foreground launch: openurl can succeed while an unanswered Open-in alert blocks delivery. */
  private async foreground(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.deps.simctl.launch(this.deps.deviceId, timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ProtoViewerForegroundError({ cause: error });
    }
  }

  private async deliver(url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.deps.simctl.openurl(["openurl", this.deps.deviceId, url], timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (error instanceof SimctlCommandTimeoutError) {
        throw new ActionableError(
          "ProtoViewer openurl timed out; the request may have been delivered. Check ProtoViewer before retrying.",
          { cause: error },
        );
      }
      // No captured simctl stderr fixture: nonzero exit, not message text, means non-delivery.
      throw new ProtoViewerEntryPointMissingError();
    }
  }

  private async cleanup(paths: readonly string[]): Promise<void> {
    // Deliberately independent of the cancelled caller, with its own short deadline.
    for (const path of paths) {
      try {
        await raceWithDeadline(() => this.deps.files.remove(path), {
          timer: this.deps.timer,
          timeoutMs: PROTOVIEWER_CLEANUP_TIMEOUT_MS,
          label: "ProtoViewer cleanup",
        });
      } catch (error) {
        logger.warn(`[protoviewer] cleanup failed: ${errorMessage(error)}`);
      }
    }
  }
}
