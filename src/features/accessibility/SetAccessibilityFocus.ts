/**
 * SetAccessibilityFocus - sets or clears the Android TalkBack accessibility-focus cursor.
 *
 * Resolves a text / contentDesc / resourceId selector to a resource-id, then asks the
 * CtrlProxy AccessibilityService to perform ACTION_ACCESSIBILITY_FOCUS ("focus") or
 * ACTION_CLEAR_ACCESSIBILITY_FOCUS ("clear_focus") on the matched node.
 *
 * Android only: iOS has no VoiceOver-focus backend wired, so the tool errors clearly
 * rather than silently no-op'ing.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import {
  ActionableError,
  BootedDevice,
  CurrentFocusResult,
  Element,
  SetAccessibilityFocusOptions,
  SetAccessibilityFocusResult,
} from "../../models";
import type { ElementResolver } from "../utility/ElementResolver";
import { matchesCtrlProxyResourceId } from "../utility/SearchableNode";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { AndroidCtrlProxyClient } from "../observe/android";
import type { FocusActionOutcome } from "../observe/android/CtrlProxyFocus";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { AccessibilityTargetResolver } from "./AccessibilityTargetResolver";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

/** The accessibility service reports focus asynchronously, so the read-back can lag the action. */
const FOCUS_READBACK_ATTEMPTS = 5;
const FOCUS_READBACK_INTERVAL_MS = 100;

function focusMatchesTarget(focused: Element | null | undefined, resourceId: string): boolean {
  return matchesCtrlProxyResourceId(focused?.["resource-id"], resourceId);
}

/**
 * Minimal accessibility-focus capability surface, so this feature can be unit-tested
 * with a fake instead of a real device/WebSocket.
 */
export interface AccessibilityFocusService {
  setAccessibilityFocus(resourceId: string): Promise<FocusActionOutcome | void>;
  clearAccessibilityFocus(resourceId: string): Promise<FocusActionOutcome | void>;
  requestCurrentFocus(): Promise<CurrentFocusResult>;
}

function unconfirmedWarning(
  action: string,
  resourceId: string,
  focusedElement: Element | undefined,
  mismatch: boolean | undefined,
  readError: string | undefined,
): string {
  const acknowledged = `Focus ${action} was acknowledged by the accessibility service but`;
  return mismatch
    ? `${acknowledged} the focus read-back still reports ${focusedElement?.["resource-id"] ?? "no element"} rather than the target ${resourceId}, so it could not be confirmed.`
    : `${acknowledged} the resulting focus state could not be read back to confirm it (${readError}).`;
}

export interface SetAccessibilityFocusDependencies {
  resolver?: Pick<ElementResolver, "resolve">;
  observeScreen?: ObserveScreen;
  /** Factory so production resolves the live CtrlProxy client lazily; fakes inject directly. */
  serviceFactory?: (device: BootedDevice) => AccessibilityFocusService;
  /** Paces the bounded read-back polling; fakes inject a FakeTimer. */
  timer?: Timer;
}

export class SetAccessibilityFocus {
  private readonly device: BootedDevice;
  private readonly target: AccessibilityTargetResolver;
  private readonly serviceFactory: (device: BootedDevice) => AccessibilityFocusService;
  private readonly timer: Timer;

  constructor(device: BootedDevice, deps: SetAccessibilityFocusDependencies = {}) {
    this.device = device;
    this.target = new AccessibilityTargetResolver(device, "accessibility focus", deps);
    this.timer = deps.timer ?? defaultTimer;
    this.serviceFactory =
      deps.serviceFactory ??
      ((d: BootedDevice) => AndroidCtrlProxyClient.getInstance(d, defaultAdbClientFactory));
  }

  async execute(options: SetAccessibilityFocusOptions): Promise<SetAccessibilityFocusResult> {
    if (this.device.platform !== "android") {
      throw new ActionableError(
        "accessibilityFocus is only supported on Android (TalkBack). iOS VoiceOver focus is not yet implemented.",
      );
    }

    const action = options.action ?? "set";

    if (!options.resourceId && !options.text && !options.contentDesc) {
      throw new ActionableError(
        "accessibilityFocus requires a selector: provide one of resourceId, text, or contentDesc.",
      );
    }

    const resourceId = await this.target.resolveResourceId(options);
    const service = this.serviceFactory(this.device);

    let alreadySatisfied = false;
    try {
      const outcome =
        action === "clear"
          ? await service.clearAccessibilityFocus(resourceId)
          : await service.setAccessibilityFocus(resourceId);
      alreadySatisfied = outcome?.alreadySatisfied === true;
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`[accessibilityFocus] Failed to ${action} focus: ${errorMessage(error)}`, error);
      return { success: false, error: message };
    }

    const { focusedElement, readError, mismatch } = await this.readBackFocus(
      service,
      action,
      resourceId,
    );
    const confirmed = readError === undefined && !mismatch;
    const warning = confirmed
      ? undefined
      : unconfirmedWarning(action, resourceId, focusedElement, mismatch, readError);
    return {
      success: true,
      focusedElement,
      confirmed,
      warning,
      ...(alreadySatisfied ? { alreadySatisfied } : {}),
    };
  }

  /**
   * Confirm the cursor moved (best-effort; never fail the operation on a read
   * error). The production client never throws from `requestCurrentFocus`: a
   * missing connection, timeout or send failure resolves with `error` set, so an
   * error result is treated exactly like a thrown read. `readError` is set iff
   * the read-back was not confirmed, letting callers distinguish "focused,
   * couldn't confirm" from "didn't focus" (#3922, #10036).
   */
  private async readBackFocus(
    service: AccessibilityFocusService,
    action: string,
    resourceId: string,
  ): Promise<{ focusedElement?: Element; readError?: string; mismatch?: boolean }> {
    let focusedElement: Element | undefined;
    for (let attempt = 0; attempt < FOCUS_READBACK_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.timer.sleep(FOCUS_READBACK_INTERVAL_MS);
      }
      const read = await this.readFocusOnce(service, action);
      if (read.readError !== undefined) {
        return { readError: read.readError };
      }
      focusedElement = read.focusedElement;
      // The read-back can lag the action by one step (it reports the previous node),
      // so only a result that agrees with the requested state counts as confirmation.
      const onTarget = focusMatchesTarget(focusedElement, resourceId);
      if (action === "clear" ? !onTarget : onTarget) {
        return { focusedElement };
      }
    }
    return { focusedElement, mismatch: true };
  }

  private async readFocusOnce(
    service: AccessibilityFocusService,
    action: string,
  ): Promise<{ focusedElement?: Element; readError?: string }> {
    try {
      const focus = await service.requestCurrentFocus();
      if (focus.error) {
        logger.warn(`[accessibilityFocus] Focus read-back after ${action} failed: ${focus.error}`);
        return { readError: focus.error };
      }
      return { focusedElement: focus.focusedElement ?? undefined };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`[accessibilityFocus] Failed to read current focus after ${action}: ${message}`);
      return { readError: message };
    }
  }
}
