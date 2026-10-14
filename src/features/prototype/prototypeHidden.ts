import { ActionableError } from "../../models/ActionableError";

export type PrototypeHiddenReason = "app_layer_window_hidden" | "device_blocked";

/** Unknown reasons from a newer device remain absent on this host. */
export function parsePrototypeHiddenReason(value: unknown): PrototypeHiddenReason | undefined {
  return value === "app_layer_window_hidden" || value === "device_blocked" ? value : undefined;
}

export function prototypeHiddenReasonSentence(
  reason: PrototypeHiddenReason,
  packageName?: string,
): string {
  return reason === "device_blocked"
    ? "the device is locked or its screen is off"
    : `it was shown with window.layer "app" and the app in front${packageName ? ` (${packageName})` : ""} hides app-layer windows drawn over it (system apps such as Settings do)`;
}

export function prototypeHiddenAdvice(reason: PrototypeHiddenReason): string {
  return reason === "device_blocked"
    ? "Wake and unlock the device (the prototype returns with its state)"
    : "Show it again without window.layer (the default layer draws over every app) or over a different app";
}

export function prototypeHiddenWarning(
  reason: PrototypeHiddenReason,
  packageName?: string,
): string {
  return `The AutoMobile prototype is hidden: ${prototypeHiddenReasonSentence(reason, packageName)}. ${prototypeHiddenAdvice(reason)}.`;
}

/** A device-reported hidden prototype exists but cannot be acted on until visible. */
export class PrototypeHiddenError extends ActionableError {
  readonly code = "prototype_hidden";
  readonly retryable = false;
  readonly nextAction: string;
  readonly details: { prototypeHiddenReason: PrototypeHiddenReason };

  constructor(reason: PrototypeHiddenReason) {
    super(
      `layer "prototype" was requested, but the AutoMobile prototype is hidden: ${prototypeHiddenReasonSentence(reason)}. ${prototypeHiddenAdvice(reason)}, or omit layer.`,
    );
    this.nextAction = prototypeHiddenAdvice(reason);
    this.details = { prototypeHiddenReason: reason };
  }
}
