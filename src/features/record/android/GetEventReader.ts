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
import { splitDeviceLine } from "./GetEventLine";

interface GetEventReaderOptions {
  adb: AdbExecutor;
  touchNode: TouchInputNode;
  /**
   * Additional pen digitizer nodes read by the same `getevent` process. Each has
   * its own axis ranges, so it needs its own scaler.
   */
  penNodes?: ReadonlyArray<{ node: TouchInputNode; scaler: GestureScaler }>;
  /** A timeline-backed scaler maps each touch with the geometry current at its DOWN. */
  scaler: GestureScaler;
  /** Display density in dp multiplier (e.g. 2.75 for 440dpi) */
  density: number;
  timer?: Timer;
}

interface NodePipeline {
  reconstructor: TouchFrameReconstructor;
  classifier: GestureClassifier;
}

/**
 * Spawns `adb shell getevent -lt <touchNode.path> [<pen paths>...]` through
 * AdbClient and pipes the output through TouchFrameReconstructor →
 * GestureClassifier, one pair per node. With several paths getevent prefixes
 * each line with its device path, which attributes the line to a node; lines
 * without a prefix belong to `touchNode`.
 *
 * Implements GestureEmitter so it can be replaced with a fake in tests.
 */
export class GetEventReader implements GestureEmitter {
  private child: AdbProcess | null = null;
  private starting = false;

  private generation = 0;
  private cleanupChild: (() => void) | null = null;
  private readonly timer: Timer;

  constructor(private readonly opts: GetEventReaderOptions) {
    this.timer = opts.timer ?? defaultTimer;
  }

  start(onGesture: (event: GestureEvent) => void, onError?: (err: Error) => void): void {
    if (this.child || this.starting) {
      return;
    } // already running
    this.starting = true;
    void this.startProcess(++this.generation, onGesture, onError);
  }

  private async startProcess(
    generation: number,
    onGesture: (event: GestureEvent) => void,
    onError?: (err: Error) => void,
  ): Promise<void> {
    const primaryNode = this.opts.touchNode;
    const pipelines = new Map<string, NodePipeline>();
    pipelines.set(primaryNode.path, this.createPipeline(primaryNode, this.opts.scaler));
    for (const { node, scaler } of this.opts.penNodes ?? []) {
      pipelines.set(node.path, this.createPipeline(node, scaler));
    }

    const args = ["shell", "getevent", "-lt", ...pipelines.keys()];

    logger.debug(`[GetEventReader] Spawning: ${args.join(" ")}`);
    try {
      const child = await this.opts.adb.spawn(args);
      if (!this.starting || generation !== this.generation) {
        child.on("error", () => {});
        child.kill();
        return;
      }
      this.child = child;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.error(`[GetEventReader] spawn error: ${normalized.message}`);
      if (generation === this.generation) {
        this.starting = false;
        onError?.(normalized);
      }
      return;
    }
    this.starting = false;
    const child = this.child;
    if (!child) {
      return;
    }

    let lineBuffer = "";
    let stderrTail = "";

    const onData = (data: Buffer): void => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      // Keep the incomplete last fragment in the buffer
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const arrivedAt = this.timer.now();
        const { path, line: eventLine } = splitDeviceLine(line);
        const pipeline = pipelines.get(path ?? primaryNode.path);
        if (!pipeline) {
          continue;
        }
        const { reconstructor, classifier } = pipeline;
        const result = reconstructor.feedLine(eventLine, arrivedAt);
        if (!result) {
          continue;
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
      if (this.child === child) {
        this.child = null;
        this.cleanupChild = null;
      }
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

    this.cleanupChild = cleanup;
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.on("error", onChildError);
    child.on("exit", onExit);
  }

  private createPipeline(node: TouchInputNode, scaler: GestureScaler): NodePipeline {
    const pressureRange: PressureRange | undefined =
      node.pressureMin !== undefined && node.pressureMax !== undefined
        ? { min: node.pressureMin, max: node.pressureMax }
        : undefined;
    return {
      reconstructor: new TouchFrameReconstructor({ singleTouch: node.kind === "pen" }),
      classifier: new GestureClassifier(scaler, this.opts.density, pressureRange),
    };
  }

  stop(): void {
    this.starting = false;
    ++this.generation;
    const child = this.child;
    this.cleanupChild?.();
    if (child && !child.killed) {
      logger.debug("[GetEventReader] Stopping getevent process");
      child.kill();
    }
    this.child = null;
  }
}

function isRawTouchFrame(
  result: ReturnType<TouchFrameReconstructor["feedLine"]>,
): result is import("./types").RawTouchFrame {
  return result !== null && "activeSlots" in result;
}
