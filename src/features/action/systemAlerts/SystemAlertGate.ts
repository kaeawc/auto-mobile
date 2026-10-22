import type { BootedDevice, ViewHierarchyResult } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
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

const defaultReader: SystemAlertHierarchyReader = {
  read: async (device, signal) =>
    (
      await new RealObserveScreen(device).execute({
        hierarchyOnly: true,
        skipScreenshot: true,
        skipCache: true,
        signal,
      })
    ).viewHierarchy,
};

const defaultTapper: SystemAlertTapper = {
  tap: (device, selector, signal) =>
    new TapOnElement(device).execute({ ...selector, action: "tap" }, { signal }),
};

function quote(alert: DetectedSystemAlert): string {
  return alert.message ? `"${alert.message}"` : `with buttons ${buttonList(alert)}`;
}

function buttonList(alert: DetectedSystemAlert): string {
  return alert.buttons.map((button) => `"${button.label}"`).join(", ");
}

function alertKey(alert: DetectedSystemAlert): string {
  return `${alert.message}\u0000${alert.buttons.map((button) => button.label).join("\u0000")}`;
}

/**
 * Answers OS permission and system alerts before a UI interaction, per the device's
 * `systemAlerts` policy (#14106). Without a policy it does nothing, not even a read. Every alert
 * it sees is returned as a warning for the action's result, so an answer is never silent; a
 * failed read or tap is a warning too, never a reason to block the action.
 */
export class SystemAlertGate {
  private readonly registry: SystemAlertPolicyRegistry;
  private readonly reader: SystemAlertHierarchyReader;
  private readonly tapper: SystemAlertTapper;

  constructor(dependencies: SystemAlertGateDependencies = {}) {
    this.registry = dependencies.registry ?? defaultSystemAlertPolicyRegistry;
    this.reader = dependencies.reader ?? defaultReader;
    this.tapper = dependencies.tapper ?? defaultTapper;
  }

  async beforeAction(device: BootedDevice, signal?: AbortSignal): Promise<string[]> {
    const policy = this.registry.get(device.deviceId);
    if (!policy || (device.platform !== "android" && device.platform !== "ios")) {
      return [];
    }
    const warnings: string[] = [];
    let lastAnswered: { key: string; label: string } | undefined;
    for (let answered = 0; ; answered += 1) {
      throwIfAborted(signal);
      const alert = await this.readAlert(device, signal, warnings);
      if (!alert) {
        return warnings;
      }
      if (lastAnswered?.key === alertKey(alert)) {
        warnings.push(
          `System alert ${quote(alert)} is still showing after tapping "${lastAnswered.label}"; ` +
            `it was left for you to answer.`,
        );
        return warnings;
      }
      if (answered >= SYSTEM_ALERT_MAX_ANSWERS_PER_ACTION) {
        warnings.push(
          `System alert ${quote(alert)} is showing after ${answered} alerts were answered before ` +
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
        `System alert ${quote(alert)} is showing (buttons ${buttonList(alert)}); ` +
          `the systemAlerts report policy left it for you to answer.`,
      );
      return undefined;
    }
    if (decision.answer === "unmatched") {
      warnings.push(
        `System alert ${quote(alert)} is unmatched: none of its buttons (${buttonList(alert)}) ` +
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
        `Failed to answer system alert ${quote(alert)} with "${label}": ${result.error ?? "the tap did not succeed"}.`,
      );
      return undefined;
    }
    warnings.push(
      `Answered system alert ${quote(alert)} with "${label}" (systemAlerts policy ${policy.policy}).`,
    );
    return label;
  }
}

let defaultGate: Pick<SystemAlertGate, "beforeAction"> | undefined;

/** The process-wide gate over {@link defaultSystemAlertPolicyRegistry}. */
export function defaultSystemAlertGate(): Pick<SystemAlertGate, "beforeAction"> {
  defaultGate ??= new SystemAlertGate();
  return defaultGate;
}

/** Replace the process-wide gate; `undefined` restores the default. */
export function setDefaultSystemAlertGateForTesting(
  gate: Pick<SystemAlertGate, "beforeAction"> | undefined,
): void {
  defaultGate = gate;
}
