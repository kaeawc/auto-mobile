import { logger } from "../../../utils/logger";
import type {
  AdbExecutor,
  AdbProcess,
} from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { GestureEmitter, GestureEvent } from "./types";
import type { TouchInputNode } from "./TouchNodeDiscovery";
import type { CoordScaler } from "./AxisRanges";
import { TouchFrameReconstructor } from "./TouchFrameReconstructor";
import { GestureClassifier } from "./GestureClassifier";

interface GetEventReaderOptions {
  adb: AdbExecutor;
  touchNode: TouchInputNode;
  scaler: CoordScaler;
  /** Display density in dp multiplier (e.g. 2.75 for 440dpi) */
  density: number;
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

  constructor(private readonly opts: GetEventReaderOptions) {}

  start(onGesture: (event: GestureEvent) => void, onError?: (err: Error) => void): void {
    if (this.child || this.starting) {
      return;
    } // already running
    this.starting = true;
    void this.startProcess(onGesture, onError);
  }

  private async startProcess(
    onGesture: (event: GestureEvent) => void,
    onError?: (err: Error) => void,
  ): Promise<void> {
    const reconstructor = new TouchFrameReconstructor();
    const classifier = new GestureClassifier(this.opts.scaler, this.opts.density);

    const args = ["shell", "getevent", "-lt", this.opts.touchNode.path];

    logger.debug(`[GetEventReader] Spawning: ${args.join(" ")}`);
    try {
      const child = await this.opts.adb.spawn(args);
      if (!this.starting) {
        child.kill();
        return;
      }
      this.child = child;
    } catch (error) {
      this.starting = false;
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.error(`[GetEventReader] spawn error: ${normalized.message}`);
      onError?.(normalized);
      return;
    }
    this.starting = false;
    const child = this.child;
    if (!child) {
      return;
    }

    let lineBuffer = "";

    child.stdout.on("data", (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      // Keep the incomplete last fragment in the buffer
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const arrivedAt = Date.now();
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
    });

    child.stderr.on("data", (data: Buffer) => {
      logger.debug(`[GetEventReader] stderr: ${data.toString().trim()}`);
    });

    child.on("error", (err: Error) => {
      logger.error(`[GetEventReader] spawn error: ${err.message}`);
      onError?.(err);
    });

    child.on("exit", (code: number | null) => {
      if (code !== null && code !== 0) {
        logger.warn(`[GetEventReader] getevent exited with code ${code}`);
      }
      this.child = null;
    });
  }

  stop(): void {
    this.starting = false;
    if (this.child && !this.child.killed) {
      logger.debug("[GetEventReader] Stopping getevent process");
      this.child.kill();
    }
    this.child = null;
  }
}

function isRawTouchFrame(
  result: ReturnType<TouchFrameReconstructor["feedLine"]>,
): result is import("./types").RawTouchFrame {
  return result !== null && "activeSlots" in result;
}
