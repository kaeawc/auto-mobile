import type {
  AdbExecutor,
  AdbProcess,
} from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { parseInputNodeChange, parseInputNodes } from "./InputNodeDiscovery";
import type { TouchInputNode } from "./TouchNodeDiscovery";
import type { GestureEmitter, GestureEvent } from "./types";

// Allow the final frames to drain across independent pipes, beyond uinput's 50 ms removal delay.
export const PEN_REMOVAL_SETTLE_MS = 250;

interface PenReader extends GestureEmitter {
  readonly isRunning: boolean;
}

interface PenTrack {
  controller: AbortController;
  reader?: PenReader;
  settleTimer?: NodeJS.Timeout;
}

interface PenHotplugReaderOptions {
  adb: AdbExecutor;
  timer: Timer;
  primary: { node: TouchInputNode; reader: PenReader };
  penNodes: readonly TouchInputNode[];
  createPenReader(node: TouchInputNode): PenReader;
}

/**
 * Keep the primary getevent stream unchanged while following transient pen devices.
 * The all-node stream supplies only add/remove notifications; gestures still come
 * from independent per-node GetEventReaders with each digitizer's probed axes.
 */
export class PenHotplugReader implements GestureEmitter {
  private running = false;
  private generation = 0;
  private readonly pens = new Map<string, PenTrack>();
  private stopMonitor?: () => void;

  constructor(private readonly opts: PenHotplugReaderOptions) {}

  start(onGesture: (event: GestureEvent) => void, onError?: (error: Error) => void): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const generation = ++this.generation;
    const { primary } = this.opts;
    if (primary.node.kind === "pen") {
      const track: PenTrack = {
        controller: new AbortController(),
        reader: primary.reader,
      };
      this.pens.set(primary.node.path, track);
      this.startPen(primary.node, track, onGesture, onError);
    } else {
      primary.reader.start(onGesture, onError);
    }
    for (const node of this.opts.penNodes) {
      const track: PenTrack = { controller: new AbortController() };
      this.pens.set(node.path, track);
      this.startPen(node, track, onGesture);
    }
    void this.monitor(generation, onGesture);
  }

  private startPen(
    node: TouchInputNode,
    track: PenTrack,
    onGesture: (event: GestureEvent) => void,
    onError?: (error: Error) => void,
  ): void {
    track.reader ??= this.opts.createPenReader(node);
    track.reader.start(
      (event) => {
        if (this.pens.get(node.path) === track) {
          onGesture(event);
        }
      },
      (error) => {
        if (this.pens.get(node.path) !== track) {
          return;
        }
        const removing = track.settleTimer !== undefined;
        this.finalizePen(node.path, track);
        if (onError && !removing) {
          onError(error);
          return;
        }
        logger.warn(
          `[PenHotplugReader] pen node ${node.path} stopped; finger recording continues: ${error.message}`,
          error,
        );
      },
    );
  }

  private async addPen(path: string, onGesture: (event: GestureEvent) => void): Promise<void> {
    const previous = this.pens.get(path);
    if (previous?.settleTimer !== undefined) {
      this.finalizePen(path, previous);
    }
    // The primary touch node is deliberately fixed for the recording's lifetime.
    if (
      this.pens.has(path) ||
      (path === this.opts.primary.node.path && this.opts.primary.node.kind !== "pen")
    ) {
      return;
    }
    const track: PenTrack = { controller: new AbortController() };
    this.pens.set(path, track);
    try {
      const { stdout } = await this.opts.adb.execute(["shell", "getevent", "-lp", path], {
        signal: track.controller.signal,
        timeoutMs: 1_000,
        noRetry: true,
      });
      if (this.pens.get(path) !== track) {
        return;
      }
      const node = parseInputNodes(stdout).pen.find((candidate) => candidate.path === path);
      if (node) {
        this.startPen(node, track, onGesture);
      } else {
        this.removePen(path);
      }
    } catch (error) {
      // Removal/stop aborts an optional probe; stale completions must not resurrect a reader.
      if (this.pens.get(path) !== track) {
        logger.debug(`[PenHotplugReader] discarded probe for removed node ${path}`, error);
        return;
      }
      this.removePen(path);
      logger.warn(
        `[PenHotplugReader] cannot read pen node ${path}; finger recording continues: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private removePen(path: string): void {
    const track = this.pens.get(path);
    if (!track || track.settleTimer !== undefined) {
      return;
    }
    if (!track.reader?.isRunning) {
      this.finalizePen(path, track);
      return;
    }
    track.settleTimer = this.opts.timer.setTimeout(
      () => this.finalizePen(path, track),
      PEN_REMOVAL_SETTLE_MS,
    );
  }

  private finalizePen(path: string, track: PenTrack): void {
    if (this.pens.get(path) !== track) {
      return;
    }
    this.pens.delete(path);
    if (track.settleTimer !== undefined) {
      this.opts.timer.clearTimeout(track.settleTimer);
      track.settleTimer = undefined;
    }
    track.controller.abort();
    track.reader?.stop();
  }

  private async monitor(
    generation: number,
    onGesture: (event: GestureEvent) => void,
  ): Promise<void> {
    let child: AdbProcess;
    try {
      child = await this.opts.adb.spawn(["shell", "getevent", "-lt"]);
    } catch (error) {
      if (generation === this.generation) {
        logger.warn(
          `[PenHotplugReader] hotplug monitor failed; finger recording continues: ${errorMessage(error)}`,
          error,
        );
      }
      return;
    }
    if (generation !== this.generation) {
      child.on("error", (error: Error) => {
        // The child is already being torn down; late errors are expected and safe to swallow.
        logger.debug("[PenHotplugReader] late error from stale hotplug monitor", error);
      });
      child.kill();
      return;
    }
    let buffer = "";
    let stderrTail = "";
    const onData = (data: Buffer): void => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const change = parseInputNodeChange(line);
        if (change?.action === "add") {
          void this.addPen(change.path, onGesture);
        } else if (change?.action === "remove") {
          this.removePen(change.path);
        }
      }
    };
    const onStderr = (data: Buffer): void => {
      stderrTail = (stderrTail + data.toString()).slice(-4096);
    };
    const cleanup = (): void => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.on("error", ignoreError);
      child.off("error", onError);
      child.off("exit", onExit);
      buffer = "";
      this.stopMonitor = undefined;
      if (!child.killed) {
        child.kill();
      }
    };
    const ignoreError = (error: Error): void => {
      // The child is already being torn down; late errors are expected and safe to swallow.
      logger.debug("[PenHotplugReader] late error after hotplug monitor cleanup", error);
    };
    const failed = (reason: string): void => {
      cleanup();
      logger.warn(
        `[PenHotplugReader] hotplug monitor stopped; finger recording continues: ${reason}` +
          (stderrTail.trim() ? `; stderr tail: ${stderrTail.trim()}` : ""),
      );
    };
    const onError = (error: Error): void => failed(error.message);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      failed(signal ? `signal ${signal}` : `code ${code}`);
    this.stopMonitor = cleanup;
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  }

  stop(): void {
    this.running = false;
    ++this.generation;
    this.stopMonitor?.();
    for (const [path, track] of this.pens) {
      this.finalizePen(path, track);
    }
    this.opts.primary.reader.stop();
  }
}
