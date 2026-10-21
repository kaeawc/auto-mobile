/**
 * PerformAccessibilityAction - performs a semantic or app-defined accessibility action on an
 * Android node through the CtrlProxy AccessibilityService (#14077): the way a TalkBack or Switch
 * Access user expands a row, dismisses a snackbar, sets a slider or runs a Compose custom action.
 */

import { ActionableError, type BootedDevice } from "../../models";
import { AndroidCtrlProxyClient } from "../observe/android";
import type { AndroidAccessibilityActionRequest } from "../observe/android/AndroidActionDispatcher";
import { SEMANTIC_NODE_ACTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol/capabilities";
import type { A11yActionResult } from "../observe/android/types";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  AccessibilityTargetResolver,
  type AccessibilityTargetResolverDependencies,
  type AccessibilityTargetSelector,
} from "./AccessibilityTargetResolver";

/** The named actions, mirroring the CtrlProxy's STANDARD_NODE_ACTIONS (plus `custom`). */
export const ACCESSIBILITY_ACTIONS = [
  "expand",
  "collapse",
  "dismiss",
  "select",
  "clear_selection",
  "show_on_screen",
  "scroll_forward",
  "scroll_backward",
  "scroll_up",
  "scroll_down",
  "scroll_left",
  "scroll_right",
  "page_up",
  "page_down",
  "page_left",
  "page_right",
  "press_and_hold",
  "set_progress",
  "custom",
] as const;

export type AccessibilityActionName = (typeof ACCESSIBILITY_ACTIONS)[number];

export interface PerformAccessibilityActionInput extends AccessibilityTargetSelector {
  action: AccessibilityActionName;
  /** For `custom`: the label of the app-defined action. */
  customAction?: string;
  /** For `set_progress`: the value to set, in the control's own range. */
  progress?: number;
  signal?: AbortSignal;
}

export interface PerformAccessibilityActionResult {
  success: boolean;
  action: AccessibilityActionName;
  resourceId: string;
  error?: string;
}

/** The CtrlProxy surface this feature needs. */
export interface AccessibilityActionService {
  supportsCommand(name: string): Promise<boolean>;
  requestAccessibilityAction(request: AndroidAccessibilityActionRequest): Promise<A11yActionResult>;
}

export interface PerformAccessibilityActionDependencies extends AccessibilityTargetResolverDependencies {
  serviceFactory?: (device: BootedDevice) => AccessibilityActionService;
}

/** Why an input is self-contradictory, before anything is resolved on the device. */
export function accessibilityActionInputError(
  input: Pick<PerformAccessibilityActionInput, "action" | "customAction" | "progress">,
): string | undefined {
  if (input.action === "custom" && !input.customAction?.trim()) {
    return "action 'custom' requires customAction, the label of the app-defined action.";
  }
  if (input.action !== "custom" && input.customAction !== undefined) {
    return "customAction is only valid with action 'custom'.";
  }
  if (input.action === "set_progress" && input.progress === undefined) {
    return "action 'set_progress' requires progress.";
  }
  if (input.action !== "set_progress" && input.progress !== undefined) {
    return "progress is only valid with action 'set_progress'.";
  }
  return undefined;
}

export class PerformAccessibilityAction {
  private readonly target: AccessibilityTargetResolver;
  private readonly serviceFactory: (device: BootedDevice) => AccessibilityActionService;

  constructor(
    private readonly device: BootedDevice,
    deps: PerformAccessibilityActionDependencies = {},
  ) {
    this.target = new AccessibilityTargetResolver(device, "accessibility action", deps);
    this.serviceFactory =
      deps.serviceFactory ??
      ((d: BootedDevice) => AndroidCtrlProxyClient.getInstance(d, defaultAdbClientFactory));
  }

  async execute(input: PerformAccessibilityActionInput): Promise<PerformAccessibilityActionResult> {
    if (this.device.platform !== "android") {
      throw new ActionableError("accessibilityAction is only supported on Android.");
    }
    const inputError = accessibilityActionInputError(input);
    if (inputError) {
      throw new ActionableError(inputError);
    }
    if (!input.resourceId && !input.text && !input.contentDesc) {
      throw new ActionableError(
        "accessibilityAction requires a selector: provide one of resourceId, text, or contentDesc.",
      );
    }
    const service = this.serviceFactory(this.device);
    if (!(await service.supportsCommand(SEMANTIC_NODE_ACTIONS_CAPABILITY))) {
      throw new ActionableError(
        "The installed CtrlProxy does not support semantic accessibility actions " +
          `(${SEMANTIC_NODE_ACTIONS_CAPABILITY}); restart the daemon so it installs the current APK.`,
      );
    }
    const resourceId = await this.target.resolveResourceId(input);
    const result = await service.requestAccessibilityAction({
      action: input.action,
      resourceId,
      ...(input.customAction !== undefined ? { customAction: input.customAction } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      success: result.success,
      action: input.action,
      resourceId,
      ...(result.success ? {} : { error: result.error ?? "The accessibility action failed." }),
    };
  }
}
