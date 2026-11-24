import type { TapCoordinatesRequest } from "../../utils/interfaces/TapCoordinatesRequest";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type {
  IosSimulatorRawInput,
  SimHidRouteMode,
} from "../../utils/ios/simHid/IosSimulatorRawInput";
import type { SimHidOutcome, SimHidScreenSize } from "../../utils/ios/simHid/SimHidProtocol";
import type { IosCoordinateTapClient } from "./coordinateTapDispatch";
import type { BootedDevice } from "../../models";
import { iosSimulatorRawInputFor } from "../../utils/ios/simHid/IosSimulatorRawInput";

/** An injected route, `null` for none, or (undefined) the shared helper for an iOS Simulator. */
export function resolveIosRawInput(
  device: Pick<BootedDevice, "platform" | "deviceId">,
  injected: IosSimulatorRawInput | null | undefined,
): IosSimulatorRawInput | undefined {
  return injected === undefined ? iosSimulatorRawInputFor(device) : (injected ?? undefined);
}

/**
 * The iOS tap client: on a simulator, wrapped so raw taps go through the HID helper (#19118).
 * An injected CtrlProxy client without an injected HID route keeps CtrlProxy only.
 */
export function withSimulatorHidTaps(
  device: Pick<BootedDevice, "platform" | "deviceId">,
  injected: { iosClient?: IosCoordinateTapClient; iosRawInput?: IosSimulatorRawInput | null },
  liveClient: () => IosCoordinateTapClient,
  screen: () => SimHidScreenSize | undefined,
): IosCoordinateTapClient {
  const ctrlProxy = injected.iosClient ?? liveClient();
  const rawInput =
    injected.iosRawInput === undefined && injected.iosClient !== undefined
      ? undefined
      : resolveIosRawInput(device, injected.iosRawInput);
  return rawInput ? new SimHidCoordinateTapClient(ctrlProxy, rawInput, screen) : ctrlProxy;
}

type PressReply = {
  success: boolean;
  error?: string;
  dispatched?: boolean;
  acknowledged?: boolean;
};

/** The simulator side (lock) button through the HID helper first, then the runner (#19118). */
export function routeSimulatorPowerPress<R extends PressReply>(
  input: IosSimulatorRawInput,
  dispatch: { signal?: AbortSignal; onDispatch?: () => void },
  runner: (onDispatch: () => void) => Promise<R>,
): Promise<R | PressReply> {
  return routeSimulatorRawInput<R | PressReply>({
    label: "power",
    signal: dispatch.signal,
    hid: async (mode) => {
      const outcome = await input.button("lock", { mode, ...dispatch });
      switch (outcome.status) {
        case "delivered":
          return { success: true, dispatched: true, acknowledged: true };
        case "indeterminate":
          return { success: false, error: outcome.reason, dispatched: true, acknowledged: false };
        case "unavailable":
          logSimHidUnavailable("power", mode, outcome.reason);
          return undefined;
      }
    },
    ctrlProxy: (markDispatched) =>
      runner(() => {
        markDispatched();
        dispatch.onDispatch?.();
      }),
    unreachable: isCtrlProxyUnreachable,
  });
}

/**
 * The observed screen in points, which the helper normalizes touches to; pixels do not qualify.
 * Only an upright portrait (rotation 0, or unknown with a portrait shape) qualifies: an
 * upside-down portrait (2) or landscape (1, 3) would land touches rotated, so it stays on CtrlProxy.
 */
export function simHidScreenFromObservation(observation: {
  screenSize?: { width: number; height: number; units?: string };
  rotation?: number;
}): SimHidScreenSize | undefined {
  const size = observation.screenSize;
  if (!size || size.units === "physical-pixels") {
    return undefined;
  }
  if (observation.rotation !== undefined && observation.rotation !== 0) {
    return undefined;
  }
  return { width: size.width, height: size.height };
}

/** `tapDiagnostics.route` for a tap the SimulatorKit HID helper delivered. */
export const SIM_HID_TAP_ROUTE = "simulatorHid" as const;

type IosTapReply = Awaited<ReturnType<IosCoordinateTapClient["requestTapCoordinates"]>>;

/**
 * A CtrlProxy reply that never reached the runner: not connected, or the transport failed
 * before the write. A runner refusal or an unconfirmed write is never this.
 */
export function isCtrlProxyUnreachable(
  result: { success: boolean; dispatched?: boolean; acknowledged?: boolean },
  dispatchedSeen: boolean,
): boolean {
  return (
    !result.success && !dispatchedSeen && result.dispatched !== true && result.acknowledged !== true
  );
}

/** Logs an outcome that sent nothing: expected in preferred mode, a real miss in fallback mode. */
export function logSimHidUnavailable(label: string, mode: SimHidRouteMode, reason: string): void {
  if (mode === "fallback") {
    logger.warn(`sim-hid-helper ${label} fallback unavailable: ${reason}`);
  } else {
    // Expected while the helper starts or for landscape layouts; CtrlProxy takes the input.
    logger.debug(`sim-hid-helper ${label} skipped: ${reason}`);
  }
}

export interface SimHidRoute<T> {
  label: string;
  signal?: AbortSignal;
  /** One attempt through the helper; undefined when it sent nothing. */
  hid(mode: SimHidRouteMode): Promise<T | undefined>;
  /** The CtrlProxy attempt; it calls `markDispatched` once the request is written. */
  ctrlProxy(markDispatched: () => void): Promise<T>;
  /** Whether a CtrlProxy result means the runner could not be reached. */
  unreachable(result: T, dispatched: boolean): boolean;
  /** A throw that is a definite answer (stale display) rather than a transport miss. */
  isDefiniteError?(error: unknown): boolean;
}

/**
 * The iOS Simulator raw-input order (#19118): the HID helper when it is running, else CtrlProxy;
 * when CtrlProxy cannot be reached before dispatch, start the helper and use it instead.
 */
export async function routeSimulatorRawInput<T>(route: SimHidRoute<T>): Promise<T> {
  const preferred = await route.hid("preferred");
  if (preferred !== undefined) {
    return preferred;
  }
  let dispatched = false;
  let result: T;
  try {
    result = await route.ctrlProxy(() => {
      dispatched = true;
    });
  } catch (error) {
    return await fallbackAfterThrow(route, error, dispatched);
  }
  if (route.signal?.aborted || !route.unreachable(result, dispatched)) {
    return result;
  }
  logger.warn(`CtrlProxy iOS ${route.label} unreachable; trying sim-hid-helper`);
  return (await route.hid("fallback")) ?? result;
}

/** CtrlProxy threw: only a throw before dispatch that is not a definite answer may fall back. */
async function fallbackAfterThrow<T>(
  route: SimHidRoute<T>,
  error: unknown,
  dispatched: boolean,
): Promise<T> {
  if (dispatched || route.signal?.aborted || route.isDefiniteError?.(error)) {
    throw error;
  }
  logger.warn(
    `CtrlProxy iOS ${route.label} threw before dispatch; trying sim-hid-helper: ${errorMessage(error)}`,
  );
  const fallback = await route.hid("fallback");
  if (fallback !== undefined) {
    return fallback;
  }
  throw error;
}

/**
 * iOS Simulator coordinate taps through {@link routeSimulatorRawInput}. Double taps and
 * display-addressed taps stay on CtrlProxy.
 */
export class SimHidCoordinateTapClient implements IosCoordinateTapClient {
  constructor(
    private readonly inner: IosCoordinateTapClient,
    private readonly input: IosSimulatorRawInput,
    private readonly screen: () => SimHidScreenSize | undefined,
  ) {}

  requestDoubleTapCoordinates(
    ...args: Parameters<IosCoordinateTapClient["requestDoubleTapCoordinates"]>
  ): ReturnType<IosCoordinateTapClient["requestDoubleTapCoordinates"]> {
    return this.inner.requestDoubleTapCoordinates(...args);
  }

  requestTapCoordinates(request: TapCoordinatesRequest): Promise<IosTapReply> {
    if (request.displayId !== undefined) {
      return this.inner.requestTapCoordinates(request);
    }
    return routeSimulatorRawInput<IosTapReply>({
      label: "tap",
      signal: request.signal,
      hid: (mode) => this.hidTap(request, mode),
      ctrlProxy: (markDispatched) =>
        this.inner.requestTapCoordinates({
          ...request,
          onDispatch: () => {
            markDispatched();
            request.onDispatch?.();
          },
        }),
      unreachable: isCtrlProxyUnreachable,
    });
  }

  private async hidTap(
    request: TapCoordinatesRequest,
    mode: SimHidRouteMode,
  ): Promise<IosTapReply | undefined> {
    const outcome = await this.input.tap(
      { x: request.x, y: request.y, holdMs: request.duration ?? 0, screen: this.screen() },
      { mode, signal: request.signal, onDispatch: request.onDispatch },
    );
    return tapReplyFromOutcome(outcome, mode);
  }
}

export function tapReplyFromOutcome(
  outcome: SimHidOutcome,
  mode: SimHidRouteMode,
): IosTapReply | undefined {
  switch (outcome.status) {
    case "delivered":
      return {
        success: true,
        dispatched: true,
        acknowledged: true,
        tapDiagnostics: { route: SIM_HID_TAP_ROUTE },
      };
    case "indeterminate":
      return { success: false, dispatched: true, acknowledged: false, error: outcome.reason };
    case "unavailable":
      logSimHidUnavailable("tap", mode, outcome.reason);
      return undefined;
  }
}
