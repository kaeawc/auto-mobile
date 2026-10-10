import {
  defaultDisplayInventoryProvider,
  type DisplayInventoryProvider,
} from "../devices/DisplayInventoryProvider";
import { logger } from "../utils/logger";
import type { BootedDevice } from "../models";
import { DaemonState } from "../daemon/daemonState";
import {
  readableDisplayInventory,
  resolveTargetDisplay,
  validateDisplayPin,
} from "../features/observe/DisplaySelection";
import {
  displayPinFailure,
  runWithSelectedDisplayPin,
} from "../features/observe/SessionDisplayContext";
import {
  DisplayInventoryUnavailableError,
  PinnedDisplayUnavailableError,
} from "../models/PinnedDisplayError";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { readToolEnvelopePayload, writeToolEnvelopePayload } from "./toolEnvelopePayload";
import { displayInventoryOutcome } from "../models/DeviceInfo";
import { selectablePanels } from "../models/DisplayPanel";

const pinRestrictedActions = new Set(["tapOn", "swipeOn"]);

export interface SessionDisplayPinStore {
  getDeviceForSession(sessionUuid: string): string | null;
  getDisplayPin(sessionUuid: string): string | undefined;
}

/** Read a fresh inventory and validate before binding; null/omitted have no probe. */
export async function prepareSessionDisplayPin(input: {
  device: BootedDevice;
  display: unknown;
  identityToken: string;
  inventory?: DisplayInventoryProvider;
}): Promise<string | null | undefined> {
  if (input.display === undefined || input.display === null) {
    return input.display;
  }
  const provider = input.inventory ?? defaultDisplayInventoryProvider;
  provider.invalidate(input.device.deviceId);
  let device: BootedDevice;
  try {
    device = await provider.hydrate(input.device, input.identityToken);
  } catch (error) {
    logger.warn("Display inventory read failed while preparing a session pin", error);
    throw new DisplayInventoryUnavailableError({
      pin: typeof input.display === "string" ? input.display : undefined,
      cause: error,
    });
  }
  const inventory = readableDisplayInventory({
    inventory: device.displays,
    outcome: device[displayInventoryOutcome],
    pin: typeof input.display === "string" ? input.display : undefined,
  });
  return validateDisplayPin(inventory, input.display);
}

function pinStore(): SessionDisplayPinStore | undefined {
  const daemon = DaemonState.getInstance();
  return daemon.isInitialized() ? daemon.getSessionManager() : undefined;
}

function stampDisplay(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("display" in value)) {
    return value;
  }
  const display = value.display;
  if (!display || typeof display !== "object" || !("generation" in display)) {
    return value;
  }
  return { ...value, display: { ...display, pinned: true } };
}

/** Rewrite both envelope representations without mutating shared capture objects. */
function stampResponse(response: unknown): void {
  const view = readToolEnvelopePayload(response);
  if (!view) {
    return;
  }
  const payload = { ...view.payload };
  if (payload.observation !== undefined) {
    payload.observation = stampDisplay(payload.observation);
  }
  if (Array.isArray(payload.commands)) {
    payload.commands = payload.commands.map((command) => {
      if (!command || typeof command !== "object") {
        return command;
      }
      return stampDisplay({ ...command, observation: stampDisplay(command.observation) });
    });
  }
  const stamped = stampDisplay(payload) as Record<string, unknown>;
  writeToolEnvelopePayload(view, stamped);
}

function pinFailureResponse(
  name: string,
  error: PinnedDisplayUnavailableError | DisplayInventoryUnavailableError,
) {
  if (name === "observe" || name === "captureScreenshot") {
    throw error;
  }
  logger.warn(error.message, error);
  return {
    ...createStructuredToolResponse({
      success: false,
      message: error.message,
      error: error.message,
      ...(error instanceof DisplayInventoryUnavailableError
        ? { displayInventory: error.details }
        : { pinnedDisplay: error.details }),
    }),
    isError: true,
  };
}

/** One device-aware tool seam for every schema declaring display, including internal calls. */
interface SessionDisplayPinInput<T = unknown> {
  name: string;
  acceptsDisplay: boolean;
  device: BootedDevice;
  args: Record<string, unknown>;
  sessionUuid?: string;
  store?: SessionDisplayPinStore;
  invoke: (args: Record<string, unknown>) => T;
}

/**
 * Calls that must never receive a session pin. Stop must remain possible after a recording's panel
 * is unplugged. A prototype is bound to the display it was shown on, so only show takes a display (and
 * therefore a session pin).
 */
function pinExempt(name: string, args: Record<string, unknown>): boolean {
  return (
    (name === "rotate" && args.display === undefined) ||
    (name === "videoRecording" && args.action === "stop") ||
    (name === "prototype" && args.action !== "show")
  );
}

export function runSessionDisplayPin<T>(input: SessionDisplayPinInput<T>): T | Promise<unknown> {
  const { name, device, args } = input;
  const eligible = input.acceptsDisplay && !pinExempt(name, args);
  const session = input.sessionUuid;
  if (args.display !== undefined) {
    // An explicit selector overrides even an enclosing internal call's pin provenance.
    return eligible && pinRestrictedActions.has(name)
      ? runWithSelectedDisplayPin(undefined, () => input.invoke(args))
      : input.invoke(args);
  }
  if (!eligible || !session) {
    return input.invoke(args);
  }
  const store = input.store ?? pinStore();
  const pin =
    store?.getDeviceForSession(session) === device.deviceId
      ? store.getDisplayPin(session)
      : undefined;
  if (pin === undefined) {
    return input.invoke(args);
  }
  return runPinnedSessionDisplay({ input, pin });
}

async function runPinnedSessionDisplay({
  input,
  pin,
}: {
  input: SessionDisplayPinInput;
  pin: string;
}): Promise<unknown> {
  const { name, device, args } = input;
  return runWithSelectedDisplayPin({ pin, inventory: device.displays }, async () => {
    try {
      const inventory = readableDisplayInventory({
        inventory: device.displays,
        outcome: device[displayInventoryOutcome],
        pin,
      });
      // Validate the pin even when ordinary input necessarily targets the same sole panel.
      const panel = resolveTargetDisplay(inventory, undefined, { displayPin: pin });
      // Inventory has no live focus/default identity. Do not infer it for multiple panels.
      const ordinaryAction =
        pinRestrictedActions.has(name) && selectablePanels(inventory).length === 1;
      const effectiveArgs = ordinaryAction ? args : { ...args, display: panel.key };
      const response = await input.invoke(effectiveArgs);
      stampResponse(response);
      return response;
    } catch (error) {
      const failure = displayPinFailure(error);
      if (
        failure instanceof PinnedDisplayUnavailableError ||
        failure instanceof DisplayInventoryUnavailableError
      ) {
        return pinFailureResponse(name, failure);
      }
      // Preserve handler error identity so device loss and cancellation retain their contracts.
      logger.warn(`Display routing handler failed for ${name}`, failure);
      throw failure;
    }
  });
}
