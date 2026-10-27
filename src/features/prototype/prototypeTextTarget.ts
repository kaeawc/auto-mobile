import type { ObserveResult } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { withImeFailure, type ImeFailureDiagnostic } from "../action/imeFailureDiagnostics";
import type { ObserveScreenExecuteOptions } from "../observe/interfaces/ObserveScreen";
import type { PrototypeSpec } from "./prototypeSpec";
import { InMemoryPrototypeTextFieldBindings } from "./InMemoryPrototypeTextFieldBindings";

export { AndroidPrototypeTextTargetReader } from "./AndroidPrototypeTextTargetReader";
export { InMemoryPrototypeTextFieldBindings } from "./InMemoryPrototypeTextFieldBindings";
export { IosPrototypeTextTargetReader } from "./IosPrototypeTextTargetReader";
export { prototypeTextFieldKeys } from "./prototypeTextFieldKeys";

/** Three reads preserve the existing prototype text verification retry bound. */
const PROTOTYPE_TEXT_VERIFY_ATTEMPTS = 3;

export type PrototypeTextReading =
  | { kind: "value"; value: string; source: "state"; stateKey: string; numericValue?: number }
  | { kind: "value"; value: string; source: "field" }
  | { kind: "unverifiable"; reason: string };

export interface PrototypeTextTarget {
  identifiers: readonly string[];
  display?: string;
}

export interface PrototypeTextTargetReader {
  read(target: PrototypeTextTarget, signal?: AbortSignal): Promise<PrototypeTextReading>;
}

export interface PrototypeTextFieldBindings {
  record(deviceId: string, spec: PrototypeSpec): void;
  forDevice(
    deviceId: string,
  ): { prototypeId: string; keys: ReadonlyMap<string, string> } | undefined;
  forget(deviceId: string): void;
  clear(): void;
}

export const prototypeTextFieldBindings: PrototypeTextFieldBindings =
  new InMemoryPrototypeTextFieldBindings();

/** Called only with the validated, expanded spec sent by the prototype tool. */
export function recordPrototypeTextShow(
  deviceId: string,
  action: string,
  spec: PrototypeSpec | undefined,
  outcome: { accepted: boolean; sent: boolean; id?: string; all?: boolean },
): void {
  if (action === "show" && outcome.accepted && spec) {
    prototypeTextFieldBindings.record(deviceId, spec);
  } else if (action === "show" && outcome.sent) {
    prototypeTextFieldBindings.forget(deviceId);
  } else if (
    action === "dismiss" &&
    outcome.accepted &&
    (outcome.all || prototypeTextFieldBindings.forDevice(deviceId)?.prototypeId === outcome.id)
  ) {
    prototypeTextFieldBindings.forget(deviceId);
  }
}

export interface PrototypeTextObserver {
  execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult>;
}

function holdsText(
  reading: Extract<PrototypeTextReading, { kind: "value" }>,
  text: string,
  operation: "insert" | "replace",
  before?: PrototypeTextReading,
): boolean {
  if (operation === "insert" && before?.kind === "value" && reading.value === before.value) {
    return false;
  }
  const matches = (sent: string) =>
    operation === "replace" ? reading.value === sent : reading.value.includes(sent);
  return (
    matches(text) ||
    (text.endsWith("\n") && matches(text.slice(0, -1))) ||
    (reading.source === "state" &&
      reading.numericValue !== undefined &&
      /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text.endsWith("\n") ? text.slice(0, -1) : text) &&
      Number(text.trim()) === reading.numericValue)
  );
}

/** One truth rule for both sources. Read failures never undo an acknowledged device command. */
export async function verifyPrototypeTextTarget(options: {
  reader: PrototypeTextTargetReader;
  target: PrototypeTextTarget;
  text: string;
  operation: "insert" | "replace";
  timer: Timer;
  settleMs: number;
  before?: PrototypeTextReading;
  signal?: AbortSignal;
}): Promise<{
  success: boolean;
  warning?: string;
  error?: string;
  partialApplication?: boolean;
  imeFailure?: ImeFailureDiagnostic;
}> {
  const { reader, target, text, operation, timer, settleMs, signal } = options;
  try {
    for (let attempt = 0; attempt < PROTOTYPE_TEXT_VERIFY_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        await timer.sleep(settleMs);
      }
      signal?.throwIfAborted();
      const reading = await reader.read(target, signal);
      if (reading.kind === "unverifiable") {
        logger.warn("Prototype text verification unavailable", { reason: reading.reason });
        return {
          success: true,
          warning: `Typed text was not verified against the prototype: ${reading.reason}`,
        };
      }
      if (holdsText(reading, text, operation, options.before)) {
        return { success: true };
      }
      if (attempt === PROTOTYPE_TEXT_VERIFY_ATTEMPTS - 1) {
        const error =
          reading.source === "state"
            ? `Prototype refused the text: sent ${JSON.stringify(text)} but prototype state key ${JSON.stringify(reading.stateKey)} holds ${JSON.stringify(reading.value)}; the field keeps showing the typed text until editing ends`
            : `Prototype refused the text: sent ${JSON.stringify(text)} but the prototype field holds ${JSON.stringify(reading.value)}`;
        return withImeFailure(
          { success: false, partialApplication: true, error },
          text,
          "verification",
          { observedText: reading.value },
        );
      }
    }
  } catch (error) {
    logger.warn("Prototype text verification failed", error);
    signal?.throwIfAborted();
    return {
      success: true,
      warning: `Typed text was not verified against the prototype: ${errorMessage(error)}`,
    };
  }
  return { success: true };
}
