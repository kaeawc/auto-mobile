import type { BootedDevice, TapAtOptions } from "../../models";
import { toActionableError } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import {
  resolveTalkBackStateConfirmation,
  TALKBACK_STATE_UNKNOWN_WARNING,
  type AccessibilityDetector,
} from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import type { FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import type { TapCoordinatesRequest } from "../observe/shared/SharedGestureDelegate";
import type {
  TalkBackNavigationDriver,
  TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import type { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import type { DisplayFence } from "./BaseVisualChange";
import {
  indeterminateTapError,
  isStaleFrameContextRejection,
  type CoordinateTapClient,
} from "./coordinateTapDispatch";
import { resolveCoordinateTapCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import { tapDurationMs } from "./tapAtGesture";

export interface AndroidCoordinateTalkBackDependencies {
  /** Read the action's live target so its public device/ADB injection seams stay effective. */
  target: { readonly device: BootedDevice; readonly adb: AdbExecutor };
  androidClient: CoordinateTapClient;
  featureFlags: FeatureFlagReader;
  accessibilityDetector: AccessibilityDetector;
  talkBackStrategy: Pick<TalkBackTapStrategy, "executePreciseTap" | "executeCoordinateFallback">;
  talkBackDriverFactory: TalkBackNavigationDriverFactory;
  useContextualFocusTap: boolean;
}

/** TalkBack state confirmation and frame-fenced coordinate activation. */
export class AndroidCoordinateTalkBack {
  constructor(private readonly dependencies: AndroidCoordinateTalkBackDependencies) {}

  async resolveState(
    signal: AbortSignal | undefined,
    onActivationWarnings?: (warnings?: string[]) => void,
  ): Promise<boolean> {
    throwIfAborted(signal);
    const { talkBack, unconfirmed } = await awaitWhileRequestIsLive(
      resolveTalkBackStateConfirmation(
        this.dependencies.accessibilityDetector,
        this.dependencies.target.device.deviceId,
        this.dependencies.target.adb,
        this.dependencies.featureFlags,
      ),
      signal,
    );
    throwIfAborted(signal);
    if (unconfirmed) {
      onActivationWarnings?.([TALKBACK_STATE_UNKNOWN_WARNING]);
    }
    return talkBack === true;
  }

  async dispatchTap(
    options: TapAtOptions,
    point: { x: number; y: number },
    frameContext: string | undefined,
    {
      signal,
      context,
    }: {
      signal?: AbortSignal;
      context: {
        assertCurrent: () => void;
        onTapDelivered: () => void;
        onDispatched?: () => void;
        onActivationWarnings?: (warnings?: string[]) => void;
      };
    },
  ): Promise<void> {
    const fence: DisplayFence = {
      assertCurrent: () => {
        throwIfAborted(signal);
        context.assertCurrent();
      },
    };
    const driver = this.dependencies.talkBackDriverFactory.createDriver(
      this.dependencies.target.device,
    );
    // Preserve the first touch's frame context and beforeSend fence on the default
    // transport: the shared navigation driver exposes neither argument. Injected
    // drivers remain the test seam for both existing strategy gestures.
    const guardedDriver: TalkBackNavigationDriver = {
      requestTraversalOrder: driver.requestTraversalOrder.bind(driver),
      requestCurrentFocus: driver.requestCurrentFocus.bind(driver),
      requestAction: driver.requestAction.bind(driver),
      requestNodeAction: driver.requestNodeAction.bind(driver),
      supportsNodeActionSelectors: driver.supportsNodeActionSelectors.bind(driver),
      requestTapCoordinates: async (request: TapCoordinatesRequest) => {
        const { x, y, duration = 10, onDispatch } = request;

        fence.assertCurrent();
        const reportDispatch = () => {
          context.onDispatched?.();
          onDispatch?.();
        };
        const result = this.dependencies.useContextualFocusTap
          ? await this.requestContextualTalkBackFocus({ x, y }, duration, frameContext, {
              signal,
              fence,
              onDispatch: reportDispatch,
            })
          : await driver.requestTapCoordinates({ x, y, duration, onDispatch: reportDispatch });
        if (result.success) {
          context.onTapDelivered();
        }
        throwIfAborted(signal);
        return { ...result, totalTimeMs: 0 };
      },
      requestDoubleTapCoordinates: async (x, y, onDispatch) => {
        fence.assertCurrent();
        const result = await driver.requestDoubleTapCoordinates(x, y, () => {
          context.onDispatched?.();
          onDispatch?.();
        });
        if (result.success) {
          // The driver's atomic request delivers the two activation touches.
          context.onTapDelivered();
          context.onTapDelivered();
        }
        throwIfAborted(signal);
        return result;
      },
    };
    const result = await awaitWhileRequestIsLive(
      options.action === "longPress"
        ? this.dependencies.talkBackStrategy.executeCoordinateFallback(
            { x: point.x, y: point.y },
            "longPress",
            tapDurationMs(options, "android"),
            guardedDriver,
            { displayFence: fence },
          )
        : // A precise TalkBack activation already contains the double-tap gesture.
          this.dependencies.talkBackStrategy.executePreciseTap(
            point.x,
            point.y,
            guardedDriver,
            fence,
          ),
      signal,
    );
    context.onActivationWarnings?.(result.warnings);
    if (!result.success) {
      throw new ActionableError(
        `TalkBack coordinate tap failed: ${result.error ?? "activation was not confirmed"}${
          result.focusCompleted
            ? " Focus touch was delivered; activation failed. Do not retry automatically."
            : ""
        }`,
      );
    }
    throwIfAborted(signal);
  }

  private async requestContextualTalkBackFocus(
    point: { x: number; y: number },
    duration: number,
    frameContext: string | undefined,
    context: { signal: AbortSignal | undefined; fence: DisplayFence; onDispatch: () => void },
  ): Promise<{ success: boolean; error?: string }> {
    const { signal, fence, onDispatch } = context;
    let dispatched = false;
    try {
      const result = await this.dependencies.androidClient.requestTapCoordinates({
        x: point.x,
        y: point.y,
        duration,
        timeoutMs: resolveCoordinateTapCtrlProxyTimeoutMs(duration),
        frameContext,
        onDispatch: () => {
          dispatched = true;
        },
        signal,
        beforeSend: fence.assertCurrent,
      });
      // A stale-frame reply proves the device rejected the focus touch. Preserve
      // tapAt's one safe retry even though the request was sent on the wire.
      if (dispatched && !isStaleFrameContextRejection(result.error)) {
        onDispatch();
      }
      return result;
    } catch (error) {
      if (dispatched) {
        onDispatch();
        throw indeterminateTapError(errorMessage(error));
      }
      throw toActionableError(error, "TalkBack focus tap failed before dispatch");
    }
  }
}
