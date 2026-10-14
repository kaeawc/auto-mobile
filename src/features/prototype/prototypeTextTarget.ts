import { z } from "zod";
import type { ObserveResult } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { getFocusedTextField, getFocusedTextLength } from "../action/ClearText";
import { withImeFailure, type ImeFailureDiagnostic } from "../action/imeFailureDiagnostics";
import { scopeObserveResultToLayer } from "../observe/hierarchyLayer";
import type { ObserveScreenExecuteOptions } from "../observe/interfaces/ObserveScreen";
import type { PrototypeAgentConnections } from "./ios/iosPrototypeTransport";
import type { PrototypeSpec } from "./prototypeSpec";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTextFieldKeys(
  node: Record<string, unknown>,
  keys: Map<string, string>,
  conflicts: Set<string>,
): void {
  if (
    node.type !== "textField" ||
    typeof node.stateKey !== "string" ||
    node.stateKey.includes("{")
  ) {
    return;
  }
  for (const identifier of [node.testTag, node.id]) {
    if (typeof identifier !== "string" || identifier.includes("{") || conflicts.has(identifier)) {
      continue;
    }
    if (keys.has(identifier) && keys.get(identifier) !== node.stateKey) {
      keys.delete(identifier);
      conflicts.add(identifier);
    } else {
      keys.set(identifier, node.stateKey);
    }
  }
}

/** Walk slots as well as containers; ambiguous and device-expanded identifiers cannot bind. */
export function prototypeTextFieldKeys(spec: PrototypeSpec): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  const conflicts = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
    } else if (isRecord(value)) {
      collectTextFieldKeys(value, keys, conflicts);
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
  };
  visit(spec.root);
  return keys;
}

export interface PrototypeTextFieldBindings {
  record(deviceId: string, spec: PrototypeSpec): void;
  forDevice(
    deviceId: string,
  ): { prototypeId: string; keys: ReadonlyMap<string, string> } | undefined;
  forget(deviceId: string): void;
  clear(): void;
}

export class InMemoryPrototypeTextFieldBindings implements PrototypeTextFieldBindings {
  private readonly devices = new Map<
    string,
    { prototypeId: string; keys: ReadonlyMap<string, string> }
  >();
  record(deviceId: string, spec: PrototypeSpec): void {
    this.devices.set(deviceId, { prototypeId: spec.id, keys: prototypeTextFieldKeys(spec) });
  }
  forDevice(deviceId: string) {
    return this.devices.get(deviceId);
  }
  forget(deviceId: string): void {
    this.devices.delete(deviceId);
  }
  clear(): void {
    this.devices.clear();
  }
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

const statusSchema = z.object({
  shown: z.boolean(),
  id: z.string().nullable(),
  state: z.record(z.union([z.string(), z.number().finite(), z.boolean()])),
});

function readPrototypeState(
  reply: unknown,
  prototypeId: string,
  key: string,
): PrototypeTextReading {
  const status = statusSchema.safeParse(reply);
  if (!status.success) {
    logger.warn("Malformed prototype status", status.error);
    return { kind: "unverifiable", reason: "malformed prototype status" };
  }
  if (!status.data.shown) {
    return { kind: "unverifiable", reason: "prototype is not shown" };
  }
  if (status.data.id !== prototypeId) {
    return { kind: "unverifiable", reason: "a different prototype id is showing" };
  }
  const value = Object.hasOwn(status.data.state, key) ? status.data.state[key] : "";
  return {
    kind: "value",
    source: "state",
    stateKey: key,
    value: String(value),
    ...(typeof value === "number" ? { numericValue: value } : {}),
  };
}

export class IosPrototypeTextTargetReader implements PrototypeTextTargetReader {
  constructor(
    private readonly dependencies: {
      deviceId: string;
      connections: PrototypeAgentConnections;
      bindings: PrototypeTextFieldBindings;
    },
  ) {}

  async read(target: PrototypeTextTarget, signal?: AbortSignal): Promise<PrototypeTextReading> {
    const { deviceId, connections, bindings } = this.dependencies;
    const binding = bindings.forDevice(deviceId);
    if (!binding) {
      return { kind: "unverifiable", reason: "no shown prototype bindings for this device" };
    }
    const key = target.identifiers
      .map((id) => binding.keys.get(id))
      .find((key) => key !== undefined);
    if (key === undefined) {
      return {
        kind: "unverifiable",
        reason: `no text-field binding for target identifiers ${JSON.stringify(target.identifiers)}`,
      };
    }
    const agent = connections.get(deviceId);
    if (!agent) {
      return { kind: "unverifiable", reason: "no prototype agent connection for this device" };
    }
    try {
      signal?.throwIfAborted();
      const reply = await agent.request("get_prototype_status");
      signal?.throwIfAborted();
      if (!reply.success) {
        return {
          kind: "unverifiable",
          reason: `prototype status request failed: ${reply.error ?? "unknown error"}`,
        };
      }
      return readPrototypeState(reply.status, binding.prototypeId, key);
    } catch (error) {
      logger.warn("Prototype text status read failed", error);
      return {
        kind: "unverifiable",
        reason: `prototype status request failed: ${errorMessage(error)}`,
      };
    }
  }
}

export interface PrototypeTextObserver {
  execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult>;
}

export class AndroidPrototypeTextTargetReader implements PrototypeTextTargetReader {
  constructor(private readonly observer: PrototypeTextObserver) {}
  async read(target: PrototypeTextTarget, signal?: AbortSignal): Promise<PrototypeTextReading> {
    try {
      const observation = scopeObserveResultToLayer(
        await this.observer.execute({
          hierarchyOnly: true,
          skipScreenshot: true,
          freshness: "fresh",
          display: target.display,
          signal,
        }),
        "prototype",
        "android",
      );
      const hierarchy = observation.viewHierarchy;
      const field = hierarchy && getFocusedTextField(hierarchy);
      if (!hierarchy || !field || field.secure) {
        return { kind: "unverifiable", reason: "no focused readable prototype text field" };
      }
      return {
        kind: "value",
        source: "field",
        value: getFocusedTextLength(hierarchy) === 0 ? "" : (field.value ?? ""),
      };
    } catch (error) {
      logger.warn("Prototype text field observation failed", error);
      return {
        kind: "unverifiable",
        reason: `prototype observation failed: ${errorMessage(error)}`,
      };
    }
  }
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
    for (let attempt = 0; attempt < 3; attempt++) {
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
      if (attempt === 2) {
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
