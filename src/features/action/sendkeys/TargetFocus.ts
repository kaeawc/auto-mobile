import { ActionableError } from "../../../models/ActionableError";
import type { BootedDevice, ObserveResult } from "../../../models";
import { selectablePanels, type DisplayPanel } from "../../../models/DisplayPanel";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseTopFocusedDisplayId } from "../../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { ObservedAndroidDisplayCache } from "../../observe/ObservationDisplay";
import type { DisplayTransitionReader } from "../../observe/DisplayTransition";
import { tapFocusFailure } from "../TapOnElement";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "../TargetDisplayAction";
import type { TargetState } from "./TargetState";
import type { IosSdkTextTarget } from "./IosSdkTextRouting";
import type {
  SendKeysCommand,
  SendKeysFailure,
  SendKeysFocusOptions,
  SendKeysKey,
  SendKeysObserver,
  SendKeysRouting,
  SendKeysSelector,
  SendKeysTargetFocuser,
} from "../SendKeys";

export interface TargetFocusDeps {
  device: BootedDevice;
  adb(): AdbExecutor;
  observer: SendKeysObserver;
  timer: Timer;
  lastRenderedObservation(): RenderedObservationReader | undefined;
  displayTransitionReader: DisplayTransitionReader;
  target: TargetState;
  isSemanticKey(key: SendKeysKey): boolean;
  focusWithKeyboardRecovery: (
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options?: SendKeysFocusOptions,
  ) => ReturnType<SendKeysTargetFocuser["focus"]>;
  setTargetLayer(layer: TargetState["effectiveLayer"]): void;
  setTargetPasswordField(passwordField: boolean): void;
  setIosSdkTextTarget(target: IosSdkTextTarget | undefined): void;
}

/**
 * Target focusing and explicit-display preparation: routes a call to its display, focuses the
 * selector, and records the resolved layer, password flag and prototype identifiers on the
 * shared TargetState. Moved out of SendKeys unchanged (#11840).
 */
export class TargetFocus {
  constructor(private readonly deps: TargetFocusDeps) {}

  async prepareExplicitDisplay(
    commands: SendKeysCommand[],
    selector: SendKeysSelector | undefined,
    display: string,
    { signal, ...options }: SendKeysFocusOptions & { signal?: AbortSignal } = {},
  ): Promise<{ displayId?: number; selector?: SendKeysSelector; assertCurrent: () => void }> {
    const target = await prepareTargetDisplayAction(
      this.deps.device,
      display,
      { execute: (options) => this.deps.observer.execute({ ...options, skipScreenshot: true }) },
      this.deps.adb(),
      {
        lastRenderedObservation: this.deps.lastRenderedObservation(),
        signal,
        transitions: this.deps.displayTransitionReader,
      },
    );
    if (
      this.deps.device.platform === "android" &&
      !selector &&
      commands.some((command) => command.action !== "key" || this.deps.isSemanticKey(command.key))
    ) {
      await this.assertFocusedDisplay(target.observation, signal);
    }
    if (selector && this.deps.device.platform === "android") {
      const focused = await this.focusSelector(selector, signal, display, options);
      if (!focused.success) {
        throw new Error(focused.error ?? "Unable to focus target field");
      }
      return { displayId: target.displayId, assertCurrent: target.assertCurrent };
    }
    return { displayId: target.displayId, selector, assertCurrent: target.assertCurrent };
  }

  async assertFocusedDisplay(observation: ObserveResult, signal?: AbortSignal): Promise<void> {
    if (selectablePanels(this.deps.device.displays).length === 1) {
      return;
    }
    // An explicitly captured panel (and its focused node) does not establish global input focus.
    const focusedWindow = observation.viewHierarchy?.windows?.find((window) => window.isFocused);
    const focusedPanel = focusedWindow
      ? await new ObservedAndroidDisplayCache(this.deps.timer).panelForLogicalId(
          this.deps.device,
          this.deps.adb(),
          focusedWindow.displayId,
          { signal, identity: focusedWindow.panelUniqueId },
        )
      : undefined;
    if (focusedPanel?.key === observation.display.key) {
      return;
    }
    // CtrlProxy only returns the pinned display's windows, so an unfocused pin cannot see which
    // display holds focus. Ask the system, on this refusal path only.
    const namedPanel = focusedPanel ?? (await this.topFocusedPanel(signal));
    const retarget = namedPanel
      ? ` Target it with setActiveDevice {display: "${namedPanel.key}"}, or use`
      : " Use";
    throw new ActionableError(
      `sendKeys on display "${observation.display.key}" requires a selector for text, clear, or IME keys because the focused panel is ${namedPanel ? `"${namedPanel.key}"` : "unknown"}.${retarget} tapOn to focus a field on display "${observation.display.key}", or clear the pin with setActiveDevice {display: null}.`,
    );
  }

  async topFocusedPanel(signal?: AbortSignal): Promise<DisplayPanel | undefined> {
    try {
      const adb = this.deps.adb();
      const result = await adb.executeCommand("shell dumpsys window | grep mTopFocusedDisplayId", {
        signal,
      });
      const displayId = parseTopFocusedDisplayId(result.stdout);
      return await new ObservedAndroidDisplayCache(this.deps.timer).panelForLogicalId(
        this.deps.device,
        adb,
        displayId,
        { signal },
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`sendKeys top focused display lookup failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  async focusTarget(
    selector?: SendKeysSelector,
    signal?: AbortSignal,
    routing: SendKeysRouting = {},
  ): Promise<SendKeysFailure | undefined> {
    if (!selector) {
      return undefined;
    }
    signal?.throwIfAborted();
    const result = await this.focusSelector(selector, signal, routing.display, {
      container: routing.container,
      selectionStrategy: routing.selectionStrategy,
      layer: routing.layer,
    });
    return result.success
      ? undefined
      : {
          index: 0,
          error: result.error ?? "Failed to focus the target element before sending keys",
        };
  }

  async focusSelector(
    selector: SendKeysSelector,
    signal?: AbortSignal,
    display?: string,
    options: SendKeysFocusOptions = {},
  ): ReturnType<SendKeysTargetFocuser["focus"]> {
    const result = await this.deps.focusWithKeyboardRecovery(selector, signal, display, options);
    signal?.throwIfAborted();
    this.deps.target.effectiveLayer =
      options.layer ?? result.layer ?? this.deps.target.effectiveLayer;
    this.deps.setTargetLayer(this.deps.target.effectiveLayer);
    this.deps.target.focusedPassword ||= result.passwordField === true;
    this.deps.setTargetPasswordField(this.deps.target.focusedPassword);
    this.deps.setIosSdkTextTarget(result.sdkTarget);
    this.deps.target.prototypeIdentifiers = [
      ...this.deps.target.prototypeIdentifiers,
      ...(result.identifiers ?? []),
    ];
    if (!result.success && result[tapFocusFailure]) {
      return {
        ...result,
        error: `${result.error} The field may be scrolled out of view; use swipeOn with lookFor to bring it into view, then retry.`,
      };
    }
    return result;
  }
}
