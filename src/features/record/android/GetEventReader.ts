import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import type {
  AdbExecutor,
  AdbProcess,
} from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { GestureEmitter, GestureEvent } from "./types";
import type { TouchInputNode } from "./TouchNodeDiscovery";
import type { GestureScaler } from "./AxisRanges";
import { TouchFrameReconstructor } from "./TouchFrameReconstructor";
import { GestureClassifier, type PressureRange } from "./GestureClassifier";
import { KernelTimeLineMerge, type KernelTimeLineMergeScope } from "./KernelTimeLineMerge";

interface GetEventReaderOptions {
  adb: AdbExecutor;
  touchNode: TouchInputNode;
  /**
   * Additional pen digitizer nodes read by their own `getevent` process each. Each has
   * its own axis ranges, so it needs its own scaler.
   */
  penNodes?: ReadonlyArray<{ node: TouchInputNode; scaler: GestureScaler }>;
  /** A timeline-backed scaler maps each touch with the geometry current at its DOWN. */
  scaler: GestureScaler;
  /** Display density in dp multiplier (e.g. 2.75 for 440dpi) */
  density: number;
  timer?: Timer;
  /** Private scope's reorder window (default 50 ms); a supplied lineMerge owns its window. */
  kernelReorderWindowMs?: number;
  /** Share kernel ordering with other readers in the same recording session. */
  lineMerge?: KernelTimeLineMergeScope;
}

/**
 * Spawns one `adb shell getevent -lt <path>` process per input node through
 * AdbClient (the touch node first, then one per pen node) and pipes each
 * process's output through a shared kernel-time reorder window, then its own
 * TouchFrameReconstructor → GestureClassifier, preserving host arrival times.
 * One process per node keeps every line attributed to its node without parsing
 * device-path prefixes. A pen process that fails is logged and dropped; finger recording
 * continues. A touch process failure is reported through `onError`.
 *
 * Implements GestureEmitter so it can be replaced with a fake in tests.
 */
export class GetEventReader implements GestureEmitter {
  private children = new Set<AdbProcess>();
  private starting = false;

  private generation = 0;
  private cleanups = new Set<() => void>();
  private readonly timer: Timer;

  constructor(private readonly opts: GetEventReaderOptions) {
    this.timer = opts.timer ?? defaultTimer;
  }

  start(onGesture: (event: GestureEvent) => void, onError?: (err: Error) => void): void {
    if (this.children.size > 0 || this.starting) {
      return;
    } // already running
    this.starting = true;
    const generation = ++this.generation;
    const lineMerge =
      this.opts.lineMerge ??
      new KernelTimeLineMerge({ timer: this.timer, windowMs: this.opts.kernelReorderWindowMs });
    void this.startProcess(generation, this.opts.touchNode, this.opts.scaler, {
      onGesture,
      onError,
      lineMerge,
    });
    for (const { node, scaler } of this.opts.penNodes ?? []) {
      void this.startProcess(generation, node, scaler, {
        onGesture,
        lineMerge,
        onError: (error) =>
          logger.warn(
            `[GetEventReader] pen node ${node.path} stopped; finger recording continues: ${error.message}`,
            error,
          ),
      });
    }
  }

  private async startProcess(
    generation: number,
    node: TouchInputNode,
    scaler: GestureScaler,
    {
      onGesture,
      onError,
      lineMerge,
    }: {
      onGesture: (event: GestureEvent) => void;
      onError?: (err: Error) => void;
      lineMerge: KernelTimeLineMergeScope;
    },
  ): Promise<void> {
    const reconstructor = new TouchFrameReconstructor({
      singleTouch: node.kind === "pen",
      onHover: (event) => {
        const samples = event.hover;
        const range = node.distanceRange;
        const first = samples?.[0];
        const mapping = first && "scalerAt" in scaler ? scaler.scalerAt(first.arrivedAt) : scaler;
        onGesture({
          ...event,
          ...(first ? { downAt: first.arrivedAt } : {}),
          hover:
            range && samples && "toScreenPoint" in mapping
              ? samples.map((sample) => ({
                  ...mapping.toScreenPoint(sample.x, sample.y),
                  arrivedAt: sample.arrivedAt,
                  ...(sample.kernelAtMs === undefined ? {} : { kernelAtMs: sample.kernelAtMs }),
                  distance: Math.min(
                    1,
                    Math.max(0, (sample.distance - range.min) / (range.max - range.min)),
                  ),
                }))
              : undefined,
        });
      },
    });
    const classifier = new GestureClassifier(
      scaler,
      this.opts.density,
      pressureRangeOf(node),
      node.tiltAxes,
    );

    const args = ["shell", "getevent", "-lt", node.path];

    logger.debug(`[GetEventReader] Spawning: ${args.join(" ")}`);
    let child: AdbProcess;
    try {
      child = await this.opts.adb.spawn(args);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.error(`[GetEventReader] spawn error: ${normalized.message}`);
      if (generation === this.generation) {
        // Only the touch process gates start(): a pen spawn failing first must not let a second
        // start() spawn duplicates while the touch spawn is still pending.
        if (node === this.opts.touchNode) {
          this.starting = false;
        }
        onError?.(normalized);
      }
      return;
    }
    if (generation !== this.generation) {
      child.on("error", () => {});
      child.kill();
      return;
    }
    this.children.add(child);
    if (node === this.opts.touchNode) {
      this.starting = false;
    }

    let lineBuffer = "";
    let stderrTail = "";

    const unregister = lineMerge.register(node.path, (line, arrivedAt) => {
      if (generation !== this.generation) {
        return;
      }
      const result = reconstructor.feedLine(line, arrivedAt);
      if (!result) {
        return;
      }
      if (isRawTouchFrame(result)) {
        const gesture = classifier.feedFrame(result);
        if (gesture) {
          onGesture(gesture);
        }
      } else {
        // GestureEvent (pressButton)
        onGesture(result);
      }
    });

    const onData = (data: Buffer): void => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      // Keep the incomplete last fragment in the buffer
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim() || generation !== this.generation) {
          continue;
        }
        const arrivedAt = this.timer.now();
        lineMerge.push(node.path, line, arrivedAt);
      }
    };

    const onStderr = (data: Buffer): void => {
      stderrTail = (stderrTail + data.toString()).slice(-4096);
      logger.debug(`[GetEventReader] stderr: ${data.toString().trim()}`);
    };

    const cleanup = (): void => {
      lineBuffer = "";
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      // EventEmitter throws on late errors without a listener, even after teardown.
      child.on("error", ignoreError);
      child.off("error", onChildError);
      child.off("exit", onExit);
      this.children.delete(child);
      this.cleanups.delete(cleanup);
      unregister();
    };
    const ignoreError = (): void => {};
    const onChildError = (err: Error): void => {
      cleanup();
      const error = stderrTail.trim()
        ? new Error(
            `[GetEventReader] getevent process error: ${err.message}; stderr tail: ${stderrTail.trim()}`,
            { cause: err },
          )
        : err;
      logger.warn(`[GetEventReader] process error: ${error.message}`);
      onError?.(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      // getevent is a continuous stream: even code 0 is unexpected before stop.
      // stop() detaches this listener before killing the child.
      const error = new Error(
        `[GetEventReader] getevent exited with ${signal ? `signal ${signal}` : `code ${code}`}` +
          (stderrTail.trim() ? `; stderr tail: ${stderrTail.trim()}` : ""),
      );
      logger.warn(error.message);
      onError?.(error);
    };

    this.cleanups.add(cleanup);
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.on("error", onChildError);
    child.on("exit", onExit);
  }

  stop(): void {
    this.starting = false;
    ++this.generation;
    const children = [...this.children];
    for (const cleanup of [...this.cleanups]) {
      cleanup();
    }
    for (const child of children) {
      if (!child.killed) {
        logger.debug("[GetEventReader] Stopping getevent process");
        child.kill();
      }
    }
    this.children.clear();
  }
}

function pressureRangeOf(node: TouchInputNode): PressureRange | undefined {
  return node.pressureMin !== undefined && node.pressureMax !== undefined
    ? { min: node.pressureMin, max: node.pressureMax }
    : undefined;
}

function isRawTouchFrame(
  result: ReturnType<TouchFrameReconstructor["feedLine"]>,
): result is import("./types").RawTouchFrame {
  return result !== null && "activeSlots" in result;
}
