import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../models";
import type { TapOnElementOptions } from "../../../models/TapOnElementOptions";
import type { ObserveScreenExecuteOptions } from "../../observe/interfaces/ObserveScreen";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { runWithToolDispatchReporter } from "../../../utils/ToolDispatchContext";
import { throwIfAborted } from "../../../utils/toolUtils";
import { RealObserveScreen } from "../../observe/ObserveScreen";
import { TapOnElement } from "../TapOnElement";
import {
  chooseSystemAlertButton,
  detectSystemAlert,
  type DetectedSystemAlert,
} from "./SystemAlertDetection";
import {
  defaultSystemAlertPolicyRegistry,
  type SystemAlertPolicy,
  type SystemAlertPolicyRegistry,
} from "./SystemAlertPolicy";

/** Alerts answered before one action at most; a longer chain is left for the caller. */
export const SYSTEM_ALERT_MAX_ANSWERS_PER_ACTION = 3;

export type SystemAlertTapSelector = { elementId: string } | { text: string };

/** Reads the current hierarchy, merged SpringBoard alerts included on iOS. */
export interface SystemAlertHierarchyReader {
  read(device: BootedDevice, signal?: AbortSignal): Promise<ViewHierarchyResult | null | undefined>;
}

/** Taps one alert button. */
export interface SystemAlertTapper {
  tap(
    device: BootedDevice,
    selector: SystemAlertTapSelector,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface SystemAlertGateDependencies {
  registry?: SystemAlertPolicyRegistry;
  reader?: SystemAlertHierarchyReader;
  tapper?: SystemAlertTapper;
}

/** The slice of an observe screen the reader uses; `RealObserveScreen` satisfies it. */
interface HierarchyScreen {
  execute(
    options: ObserveScreenExecuteOptions,
  ): Promise<Pick<ObserveResult, "viewHierarchy" | "error">>;
}

/** The slice of a tap action the tapper uses; `TapOnElement` satisfies it. */
interface TapAction {
  execute(
    options: TapOnElementOptions,
    call: { signal?: AbortSignal },
  ): Promise<{ success: boolean; error?: string }>;
}

/** Reads through an observe screen; a capture that yields no hierarchy is a failed read. */
export function createObserveHierarchyReader(
  screenFor: (device: BootedDevice) => HierarchyScreen = (device) => new RealObserveScreen(device),
): SystemAlertHierarchyReader {
  return {
    read: async (device, signal) => {
      const result = await screenFor(device).execute({
        hierarchyOnly: true,
        skipScreenshot: true,
        skipCache: true,
        signal,
      });
      // A failed capture returns a fallback without a hierarchy rather than throwing; surface it.
      if (!result.viewHierarchy) {
        throw new ActionableError(result.error ?? "the hierarchy read returned no view hierarchy");
      }
      return result.viewHierarchy;
    },
  };
}

const ignoreDispatch = (): void => {};

/** Taps with `tapOn`'s element resolution, outside the running tool's dispatch report. */
export function createTapOnTapper(
  tapFor: (device: BootedDevice) => TapAction = (device) => new TapOnElement(device),
): SystemAlertTapper {
  return {
    // The alert tap is not the running tool's gesture: keep it from marking that tool
    // dispatched, or the tool's real tap would lose its navigation attribution window.
    tap: (device, selector, signal) =>
      runWithToolDispatchReporter(ignoreDispatch, () =>
        tapFor(device).execute({ ...selector, action: "tap" }, { signal }),
      ),
  };
}

/** `system alert "<text>"`, or `alert "<text>"` when it is not a recognized permission prompt. */
function describe(alert: DetectedSystemAlert): string {
  const what = alert.recognized ? "system alert" : "alert";
  return alert.message ? `${what} "${alert.message}"` : `${what} with buttons ${buttonList(alert)}`;
}

function sentence(alert: DetectedSystemAlert): string {
  const text = describe(alert);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buttonList(alert: DetectedSystemAlert): string {
  return alert.buttons.map((button) => `"${button.label}"`).join(", ");
}

function alertKey(alert: DetectedSystemAlert): string {
  return `${alert.message}\u0000${alert.buttons.map((button) => button.label).join("\u0000")}`;
}

/**
 * Answers OS permission and system alerts around a UI interaction, per the device's
 * `systemAlerts` policy (#14106): before it, so the action reaches the app, and after it, so a
 * prompt the action raised is answered even when no gated action follows. Without a policy it
 * does nothing, not even a read. Every alert it sees is returned as a warning for the action's
 * result and every answer is logged, so an answer is never silent; a failed read or tap is a
 * warning too, never a reason to block the action.
 */
export class SystemAlertGate {
  private readonly registry: SystemAlertPolicyRegistry;
  private readonly reader: SystemAlertHierarchyReader;
  private readonly tapper: SystemAlertTapper;

  constructor(dependencies: SystemAlertGateDependencies = {}) {
    this.registry = dependencies.registry ?? defaultSystemAlertPolicyRegistry;
    this.reader = dependencies.reader ?? createObserveHierarchyReader();
    this.tapper = dependencies.tapper ?? createTapOnTapper();
  }

  beforeAction(device: BootedDevice, signal?: AbortSignal): Promise<string[]> {
    return this.handleAlerts(device, signal, "before");
  }

  afterAction(device: BootedDevice, signal?: AbortSignal): Promise<string[]> {
    return this.handleAlerts(device, signal, "after");
  }

  private async handleAlerts(
    device: BootedDevice,
    signal: AbortSignal | undefined,
    phase: "before" | "after",
  ): Promise<string[]> {
    if (device.platform !== "android" && device.platform !== "ios") {
      return [];
    }
    const warnings: string[] = [];
    let lastAnswered: { key: string; label: string } | undefined;
    for (let answered = 0; ; answered += 1) {
      // Re-read each round: a clear or release mid-loop stops the next tap.
      const policy = this.registry.get(device.deviceId);
      if (!policy) {
        return warnings;
      }
      throwIfAborted(signal);
      const alert = await this.readAlert(device, signal, warnings);
      if (!alert) {
        return warnings;
      }
      if (lastAnswered?.key === alertKey(alert)) {
        warnings.push(
          `${sentence(alert)} is still showing after tapping "${lastAnswered.label}"; ` +
            `it was left for you to answer.`,
        );
        return warnings;
      }
      if (answered >= SYSTEM_ALERT_MAX_ANSWERS_PER_ACTION) {
        warnings.push(
          `${sentence(alert)} is showing after ${answered} alerts were answered ${phase} ` +
            `this action; it was left for you to answer.`,
        );
        return warnings;
      }
      const tapped = await this.answer(device, alert, policy, signal, warnings);
      if (!tapped) {
        return warnings;
      }
      lastAnswered = { key: alertKey(alert), label: tapped };
    }
  }

  private async readAlert(
    device: BootedDevice,
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<DetectedSystemAlert | null> {
    try {
      const platform = device.platform === "ios" ? "ios" : "android";
      return detectSystemAlert(platform, await this.reader.read(device, signal));
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[systemAlerts] Hierarchy read failed on ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      warnings.push(
        `Could not check for a system alert before this action: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /** Taps the policy's button and returns its label, or records why it did not. */
  private async answer(
    device: BootedDevice,
    alert: DetectedSystemAlert,
    policy: SystemAlertPolicy,
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<string | undefined> {
    const decision = chooseSystemAlertButton(alert, policy.policy, policy.match);
    if (decision.answer === "report") {
      warnings.push(
        `${sentence(alert)} is showing (buttons ${buttonList(alert)}); ` +
          `the systemAlerts report policy left it for you to answer.`,
      );
      return undefined;
    }
    if (decision.answer === "unmatched") {
      warnings.push(
        `${sentence(alert)} is unmatched: none of its buttons (${buttonList(alert)}) ` +
          `fits the systemAlerts ${policy.policy} policy, so it was left for you to answer. ` +
          `Add a match entry naming the button to answer it.`,
      );
      return undefined;
    }
    const { label, selector } = decision.button;
    let result: { success: boolean; error?: string };
    try {
      result = await this.tapper.tap(device, selector, signal);
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[systemAlerts] Tapping "${label}" failed on ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      result = { success: false, error: errorMessage(error) };
    }
    if (!result.success) {
      warnings.push(
        `Failed to answer ${describe(alert)} with "${label}": ${result.error ?? "the tap did not succeed"}.`,
      );
      return undefined;
    }
    const answer = `Answered ${describe(alert)} with "${label}" (systemAlerts policy ${policy.policy}).`;
    // Composite tools (navigateTo, setUIState) drop inner warnings; the log keeps the trace.
    logger.info(`[systemAlerts] ${device.deviceId}: ${answer}`);
    warnings.push(answer);
    return label;
  }
}

let defaultGate: Pick<SystemAlertGate, "beforeAction" | "afterAction"> | undefined;

/** The process-wide gate over {@link defaultSystemAlertPolicyRegistry}. */
export function defaultSystemAlertGate(): Pick<SystemAlertGate, "beforeAction" | "afterAction"> {
  defaultGate ??= new SystemAlertGate();
  return defaultGate;
}

/** Replace the process-wide gate; `undefined` restores the default. */
export function setDefaultSystemAlertGateForTesting(
  gate: Pick<SystemAlertGate, "beforeAction" | "afterAction"> | undefined,
): void {
  defaultGate = gate;
}
