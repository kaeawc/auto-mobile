import {
  ActionableError,
  BootedDevice,
  ObserveResult,
  TapAtOptions,
  TapAtResult,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { BaseVisualChange, type ProgressCallback } from "./BaseVisualChange";
import {
  type CoordinateTapClient,
  dispatchAndroidCoordinateTap,
  dispatchIosCoordinateTap,
} from "./coordinateTapDispatch";

const ANDROID_TAP_DURATION_MS = 10;
const IOS_TAP_DURATION_MS = 50;

type AndroidCoordinateTapDispatch = typeof dispatchAndroidCoordinateTap;
type IosCoordinateTapDispatch = typeof dispatchIosCoordinateTap;

function hasPositiveScreenSize(screenSize: ObserveResult["screenSize"] | undefined): boolean {
  if (!screenSize) {
    return false;
  }
  return (
    Number.isFinite(screenSize.width) &&
    Number.isFinite(screenSize.height) &&
    screenSize.width > 0 &&
    screenSize.height > 0
  );
}

export interface TapAtCoordinateDependencies {
  timer?: Timer;
  androidClient?: CoordinateTapClient;
  iosClient?: CoordinateTapClient;
  dispatchAndroidCoordinateTap?: AndroidCoordinateTapDispatch;
  dispatchIosCoordinateTap?: IosCoordinateTapDispatch;
}

/** Tap one absolute point in the native coordinate space reported by observe. */
export class TapAtCoordinate extends BaseVisualChange {
  private readonly androidClient: CoordinateTapClient;
  private readonly iosClient: CoordinateTapClient;
  private readonly androidCoordinateTap: AndroidCoordinateTapDispatch;
  private readonly iosCoordinateTap: IosCoordinateTapDispatch;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: TapAtCoordinateDependencies = {},
  ) {
    super(device, adb, dependencies.timer);
    this.androidClient =
      dependencies.androidClient ?? AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.iosClient = dependencies.iosClient ?? IOSCtrlProxyClient.getInstance(device);
    this.androidCoordinateTap =
      dependencies.dispatchAndroidCoordinateTap ?? dispatchAndroidCoordinateTap;
    this.iosCoordinateTap = dependencies.dispatchIosCoordinateTap ?? dispatchIosCoordinateTap;
  }

  async execute(
    options: TapAtOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<TapAtResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAt");

    try {
      throwIfAborted(signal);
      return await this.observedInteraction(
        async () => {
          // This is deliberately not the cached observation used by other actions:
          // the point is validated against the current screen immediately before it
          // is sent to the native runner. Omitting skipWaitForFresh requests a fresh
          // full observation, which also supplies the optional frame-context token.
          const observeResult = await this.observeScreen.execute({ signal, perf });
          const resolved = this.resolveCoordinates(options, observeResult);
          if ("error" in resolved) {
            return { success: false, x: resolved.x, y: resolved.y, error: resolved.error };
          }

          const frameContext = observeResult.viewHierarchy?.frameContext;
          switch (this.device.platform) {
            case "android":
              await this.androidCoordinateTap(
                this.androidClient,
                this.adb,
                resolved.x,
                resolved.y,
                ANDROID_TAP_DURATION_MS,
                frameContext,
                signal,
              );
              break;
            case "ios":
              await this.iosCoordinateTap(
                this.iosClient,
                resolved.x,
                resolved.y,
                IOS_TAP_DURATION_MS,
                frameContext,
              );
              break;
            default:
              throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
          }

          return { success: true, x: resolved.x, y: resolved.y };
        },
        {
          changeExpected: false,
          progress,
          perf,
          signal,
          // The authoritative pre-dispatch observation is the fresh observation
          // above; do not resolve a cached one first.
          skipPreviousObserve: true,
          predictionContext: {
            toolName: "tapAt",
            toolArgs: { x: options.x, y: options.y, platform: this.device.platform },
          },
        },
      );
    } catch (error) {
      return {
        success: false,
        x: this.device.platform === "android" ? Math.round(options.x) : options.x,
        y: this.device.platform === "android" ? Math.round(options.y) : options.y,
        error: `Failed to tap at coordinates: ${errorMessage(error)}`,
      };
    } finally {
      perf.end();
    }
  }

  private resolveCoordinates(
    options: TapAtOptions,
    observeResult: ObserveResult,
  ): { x: number; y: number } | { x: number; y: number; error: string } {
    const x = this.device.platform === "android" ? Math.round(options.x) : options.x;
    const y = this.device.platform === "android" ? Math.round(options.y) : options.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x, y, error: "tapAt requires finite x and y coordinates" };
    }

    const screenSize = observeResult.screenSize;
    if (!hasPositiveScreenSize(screenSize)) {
      return { x, y, error: "tapAt requires a positive screenSize from a fresh observation" };
    }
    if (x < 0 || x >= screenSize.width || y < 0 || y >= screenSize.height) {
      return {
        x,
        y,
        error: `tapAt coordinates (${x}, ${y}) are outside screen bounds [0, ${screenSize.width}) x [0, ${screenSize.height})`,
      };
    }
    return { x, y };
  }
}
