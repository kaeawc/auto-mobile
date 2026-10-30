import { resolveDisplayFence, type DisplayFenceOption } from "./BaseVisualChange";
import {
  ORDINARY_TAP_DURATION_MS,
  resolveGestureCtrlProxyTimeoutMs as resolveTapAnyCtrlProxyTimeoutMs,
} from "./gestureTransportTimeout";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError, BootedDevice, Element, type Point } from "../../models";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../observe/ios";
import { throwIfAborted } from "../../utils/toolUtils";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import {
  dispatchIosCoordinateTap,
  dispatchIosDoubleTap,
  indeterminateTapError,
} from "./coordinateTapDispatch";
import { resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs } from "./tapAnyCtrlProxyTimeout";

export interface TapAnyIosTapperDependencies {
  device: BootedDevice;
  iosVoiceOverDetector: IosVoiceOverDetector;
  featureFlags: FeatureFlagReader;
}

/** iOS tapAny dispatch through coordinates or VoiceOver activation. */
export class TapAnyIosTapper {
  constructor(private readonly deps: TapAnyIosTapperDependencies) {}

  /**
   * Execute a tap/doubleTap/longPress action on iOS via the CtrlProxy gesture API.
   *
   * `IOSCtrlProxyClient` has no `tap`/`doubleTap`/`longPress` methods; the real
   * gesture API is `requestTapCoordinates`, which `TapOnElement.executeiOSTapWithCoordinates`
   * also uses. A bare coordinate press under VoiceOver only focuses an element,
   * so VoiceOver targets use semantic activation and report activation failures.
   */
  async executeIosTap(
    action: string,
    point: Point,
    longPressDuration: number,
    element?: Element,
    fenceOptions: DisplayFenceOption & {
      signal?: AbortSignal;
      scoped?: boolean;
      voiceOverEnabled?: boolean;
    } = {},
  ): Promise<void> {
    const { signal } = fenceOptions;
    const fence = fenceOptions.displayFence;
    const xcTestClient = IOSCtrlProxyClient.getInstance(this.deps.device);
    // Fail-safe tap-bias variant (#6267): an indeterminate probe must route
    // through the VoiceOver activation gesture rather than a plain
    // coordinate touch that would get reported as a successful activation.
    // `signal` is threaded through so a caller deadline that already expired
    // while `ensureConnected()`/auto-setup was resolving aborts this probe
    // before dispatch, rather than after the caller has given up (issue
    // #6306 review).
    const isVoiceOverEnabled =
      fenceOptions.voiceOverEnabled ??
      (await this.deps.iosVoiceOverDetector.isVoiceOverActiveOrUnknown(
        this.deps.device.deviceId,
        xcTestClient,
        this.deps.featureFlags,
        undefined,
        signal,
      ));

    if (isVoiceOverEnabled && element) {
      await this.executeIosTapWithVoiceOver(xcTestClient, action, element, {
        durationMs: longPressDuration,
        scoped: fenceOptions.scoped,
        signal,
      });
      return;
    }

    await this.executeIosTapWithCoordinates(xcTestClient, action, point, longPressDuration, {
      signal,
      displayFence: fence,
    });
  }

  /**
   * Execute iOS tap using coordinate-based input (standard mode).
   *
   * CtrlProxy blocks its reply until the on-device press actually completes, so
   * every action sizes the request timeout from its press duration —
   * `requestTapCoordinates`'s own generic default timeout would otherwise apply
   * to an ordinary tap/doubleTap, leaving it with no tapAny-specific floor/ceiling
   * tailored to a quick gesture (issue #6276). An ordinary tap/doubleTap floors
   * that explicit timeout at `TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS` --
   * the established default `requestTapCoordinates` already applied -- so sizing
   * it from the short fixed press duration never SHRINKS the window a slow-but-
   * healthy CtrlProxy round trip already had (issue #6306 review, P1).
   */
  async executeIosTapWithCoordinates(
    xcTestClient: IosCtrlProxy,
    action: string,
    point: Point,
    longPressDuration: number,
    fenceOptions: DisplayFenceOption & { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { signal } = fenceOptions;
    const fence = resolveDisplayFence(fenceOptions);
    // Short fixed duration for tap/doubleTap, caller-supplied duration for longPress.
    const tapDuration = action === "longPress" ? longPressDuration : ORDINARY_TAP_DURATION_MS;
    const timeoutMs =
      action === "longPress"
        ? resolveTapAnyCtrlProxyTimeoutMs(tapDuration)
        : resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs(tapDuration);

    // `signal` reaches `sendCommand` as `abortSignal`: a caller deadline that
    // already fired while `ensureConnected()` was resolving a reconnect/
    // auto-setup (not itself cancellable) is checked right after that await
    // and before dispatch, so the gesture is never sent to the device after
    // the caller has already given up and returned a timeout (issue #6306
    // review, P1/P2).
    if (action === "doubleTap") {
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence.assertCurrent();
      await dispatchIosDoubleTap(xcTestClient, point, tapDuration, undefined, {
        signal,
        timeoutMs,
      });
      return;
    }

    // Once beforeSend lands, also pass this as the dispatch's beforeSend.
    fence.assertCurrent();
    throwIfAborted(signal);
    try {
      await dispatchIosCoordinateTap(xcTestClient, point, tapDuration, undefined, {
        signal,
        timeoutMs,
      });
    } catch (error) {
      logger.warn(`[TapAnyElement] CtrlProxy iOS tap failed: ${errorMessage(error)}`, error);
      if (action === "longPress") {
        // The client cannot confirm native cancellation or whether dispatch occurred.
        throw new ActionableError(
          `iOS long press failed: ${errorMessage(error)}; press may still be held on the device for up to ${tapDuration} ms. Wait ${tapDuration} ms before retrying touch input.`,
          { cause: error },
        );
      }
      throw toActionableError(error, "CtrlProxy iOS tap failed");
    }
  }

  /**
   * Execute iOS tap using VoiceOver accessibility actions.
   *
   * Prefers activating by `resource-id` (`requestAction`, mirroring how
   * `TapOnElement`/`TalkBackTapStrategy` activate Android elements by resourceId) —
   * on-device this resolves the element via `elementLocator.findElement(byResourceId:)`
   * and calls `found.tap()`/`found.press()` on the *specific* node the selector
   * matched. Nested/unique calls instead use the selected bounds with the label,
   * because resource-ID activation can reselect a peer outside the scope.
   * For legacy calls, only when no usable resource-id exists does this fall back to
   * activating by accessibility label (`requestVoiceOverActivate`): CtrlProxy
   * resolves a label via `.firstMatch`, a global (not container-scoped) query, so
   * an element whose label is shared by multiple controls could activate a
   * *different*, same-labeled control than the one tapAny selected (issue #6248
   * review, funaa). Only when NEITHER a resource-id nor a label exists — nothing to
   * activate semantically — does this throw instead of falling back to a coordinate
   * press: under VoiceOver a bare coordinate press only *focuses* an element rather
   * than activating it, so reporting success after that fallback (or after a real
   * activation attempt fails) would mask a real activation failure (issue #6248
   * review). This mirrors the non-fallback-on-failure behavior `TapOnElement` should
   * also have for the same reason.
   */
  private resolveIosVoiceOverLabel(element: Element): string | undefined {
    // ios-accessibility-label > content-desc > text > fallback
    const accessibilityLabel: string | undefined = element["ios-accessibility-label"];
    return (
      accessibilityLabel ??
      (typeof element["content-desc"] === "string" && element["content-desc"]
        ? element["content-desc"]
        : undefined) ??
      (typeof element.text === "string" && element.text ? element.text : undefined)
    );
  }

  private resolveIosResourceId(element: Element): string | undefined {
    return typeof element["resource-id"] === "string" && element["resource-id"]
      ? element["resource-id"]
      : undefined;
  }

  /**
   * Activate a resource-id-only target (no resolvable label) through the
   * identifier-based node-action path rather than a coordinate press.
   */
  private async activateIosByResourceId(
    xcTestClient: IosCtrlProxy,
    resourceId: string,
    voiceOverAction: "activate" | "long_press",
    request: { timeoutMs: number | undefined; duration?: number; signal?: AbortSignal },
  ): Promise<void> {
    const { timeoutMs, duration, signal } = request;
    let dispatched = false;
    let result: Awaited<ReturnType<IosCtrlProxy["requestAction"]>>;
    try {
      result = await xcTestClient.requestAction(
        voiceOverAction,
        resourceId,
        undefined,
        timeoutMs,
        undefined,
        {
          ...(duration === undefined ? {} : { duration }),
          abortSignal: signal,
          onDispatch: () => {
            dispatched = true;
          },
        },
      );
    } catch (error) {
      // A socket failure after the write is unconfirmed; a refusal or the caller's abort is not.
      if (dispatched && !(error instanceof ActionableError) && error !== signal?.reason) {
        throw indeterminateTapError(errorMessage(error));
      }
      throw error;
    }
    this.confirmIosVoiceOverDispatch(result);
    if (!result.success) {
      throw new ActionableError(
        `VoiceOver action failed for resource-id "${resourceId}": ${result.error ?? "unknown error"}`,
      );
    }
  }

  /** A VoiceOver activation that was written but never answered may have landed. */
  private confirmIosVoiceOverDispatch(result: {
    error?: string;
    dispatched?: boolean;
    acknowledged?: boolean;
  }): void {
    if (result.dispatched && result.acknowledged !== true) {
      throw indeterminateTapError(result.error);
    }
  }

  private async executeIosTapWithVoiceOver(
    xcTestClient: IosCtrlProxy,
    action: string,
    element: Element,
    pressOptions: { durationMs: number; scoped?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    const longPressDuration = pressOptions.durationMs;
    const label = this.resolveIosVoiceOverLabel(element);
    const resourceId = pressOptions.scoped ? undefined : this.resolveIosResourceId(element);

    const voiceOverAction: "activate" | "long_press" =
      action === "longPress" ? "long_press" : "activate";
    // Ordinary tap/doubleTap floors at the established default (P1 fix, issue #6306
    // review) the same way `executeIosTapWithCoordinates` does -- longPress keeps
    // tracking its caller-supplied duration exactly, with no floor.
    const timeoutMs =
      action === "longPress"
        ? resolveTapAnyCtrlProxyTimeoutMs(longPressDuration)
        : resolveTapAnyOrdinaryTapCtrlProxyTimeoutMs(ORDINARY_TAP_DURATION_MS);

    if (resourceId) {
      await this.activateIosByResourceId(xcTestClient, resourceId, voiceOverAction, {
        timeoutMs,
        duration: action === "longPress" ? longPressDuration : undefined,
        signal: pressOptions.signal,
      });
      return;
    }

    if (!label) {
      throw new ActionableError(
        pressOptions.scoped
          ? "Scoped VoiceOver activation requires a label and selected bounds; global resource-ID activation cannot preserve the scope"
          : "VoiceOver is enabled but the selected element has no accessibility label, " +
              "content-desc, text, or resource-id to activate; a coordinate press would " +
              "only focus it under VoiceOver, not activate it",
      );
    }

    const result = await xcTestClient.requestVoiceOverActivate(
      label,
      voiceOverAction,
      timeoutMs,
      undefined,
      {
        bounds: element.bounds,
        duration: action === "longPress" ? longPressDuration : undefined,
      },
    );

    this.confirmIosVoiceOverDispatch(result);
    if (!result.success) {
      throw new ActionableError(
        `VoiceOver action failed for label "${label}": ${result.error ?? "unknown error"}`,
      );
    }
  }
}
