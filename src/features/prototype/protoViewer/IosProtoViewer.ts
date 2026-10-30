import { join } from "node:path";
import { ActionableError } from "../../../models/ActionableError";
import type { Timer } from "../../../utils/SystemTimer";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import {
  PROTOVIEWER_CLEANUP_TIMEOUT_MS,
  PROTOVIEWER_RESULT_POLL_MS,
  ProtoViewerInboxUnsupportedError,
  ProtoViewerForegroundError,
  ProtoViewerStorageError,
  type ProtoViewerDevice,
} from "./protoViewerDevice";
import {
  PROTOVIEWER_IOS_MCP_FOLDER,
  PROTOVIEWER_INBOX_FOLDER,
  PROTOVIEWER_RESULTS_FOLDER,
  PROTOVIEWER_REQUEST_ID,
  PROTOVIEWER_IOS_DELIVERY,
  type ProtoViewerIosRequest,
  type ProtoViewerResult,
} from "./protoViewerContract";
import { pollProtoViewerResult } from "./pollProtoViewerResult";
/** A cold launch may use most of the budget; the result still gets this long (as on Android). */
const PROTOVIEWER_MIN_RESULT_WAIT_MS = 1_000;

export interface IosProtoViewerSimctl {
  installed(udid: string, signal?: AbortSignal): Promise<boolean>;
  dataContainer(udid: string, signal?: AbortSignal): Promise<string>;
  /**
   * Brings ProtoViewer to the foreground without custom-scheme delivery or system confirmation.
   */
  launch(udid: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
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
/** Simulator filesystem inbox delivery; physical devices retain the template path. */
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
    const requestPath = join(inboxDir, `${request}.request`);
    const requestTemporary = `${requestPath}.tmp`;
    try {
      await this.prepare({ inboxDir, resultsDir, temporary, inbox }, work, signal);
      signal?.throwIfAborted();
      await this.foreground(timeoutMs, signal);
      await this.requireFileDelivery(
        root,
        Math.max(0, timeoutMs - (this.deps.timer.now() - started)),
        signal,
      );
      await this.deliverRequest(requestTemporary, requestPath, work, signal);
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
        "Retrying the same spec is safe: imports are idempotent. Open ProtoViewer and unlock the simulator if it is locked.",
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
      await this.cleanup([requestPath, requestTemporary, resultPath, inbox, temporary]);
    }
  }

  private async prepare(
    {
      inboxDir,
      resultsDir,
      temporary,
      inbox,
    }: { inboxDir: string; resultsDir: string; temporary: string; inbox: string },
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

  private async deliverRequest(
    requestTemporary: string,
    requestPath: string,
    work: { bytes: Uint8Array; label?: string } | { libraryId: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const command: ProtoViewerIosRequest =
      "bytes" in work
        ? { action: "import", ...(work.label === undefined ? {} : { label: work.label }) }
        : { action: "open", libraryId: work.libraryId };
    try {
      signal?.throwIfAborted();
      await this.deps.files.write(
        requestTemporary,
        new TextEncoder().encode(JSON.stringify(command)),
      );
      await this.deps.files.rename(requestTemporary, requestPath);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ProtoViewerStorageError(
        `Could not publish ProtoViewer's request: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /** Launch makes the scene active so its inbox consumer can run. */
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

  private async requireFileDelivery(
    root: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = this.deps.timer.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      if (
        (await this.deps.files.read(join(root, "delivery"))).trim() === PROTOVIEWER_IOS_DELIVERY
      ) {
        return;
      }
      await this.deps.timer.sleep(
        Math.min(PROTOVIEWER_RESULT_POLL_MS, Math.max(0, deadline - this.deps.timer.now())),
      );
    } while (this.deps.timer.now() < deadline);
    throw new ProtoViewerInboxUnsupportedError();
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
