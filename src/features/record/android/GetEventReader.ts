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
import { GestureClassifier } from "./GestureClassifier";

interface GetEventReaderOptions {
  adb: AdbExecutor;
  touchNode: TouchInputNode;
  /** A timeline-backed scaler maps each touch with the geometry current at its DOWN. */
  scaler: GestureScaler;
  /** Display density in dp multiplier (e.g. 2.75 for 440dpi) */
  density: number;
  timer?: Timer;
}

/**
 * Spawns `adb shell getevent -lt <touchNode.path>` through AdbClient and pipes
 * the output through TouchFrameReconstructor → GestureClassifier.
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
    const reconstructor = new TouchFrameReconstructor();
    const classifier = new GestureClassifier(this.opts.scaler, this.opts.density);

    const args = ["shell", "getevent", "-lt", this.opts.touchNode.path];

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
        const result = reconstructor.feedLine(line, arrivedAt);
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
