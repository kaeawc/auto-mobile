import { AMBIENT_ENV, ENV, readEnvBool, readEnvRaw } from "../../../config/env";
import type { BootedDevice } from "../../../models";
import { resolveIosDeviceKind } from "../../ios-cmdline-tools/IosDeviceKind";
import { defaultIdGenerator } from "../../IdGenerator";
import { defaultTimer } from "../../SystemTimer";
import { throwIfAborted } from "../../toolUtils";
import { DefaultSimHidHelperProvider } from "./SimHidHelperProvider";
import { simHidLaunchSettle, type SimHidLaunchSettle } from "./SimHidLaunchSettle";
import { DefaultSimHidProcessLauncher } from "./SimHidProcessLauncher";
import type {
  SimHidButton,
  SimHidCommand,
  SimHidOutcome,
  SimHidScreenSize,
} from "./SimHidProtocol";
import { SimHidSessions } from "./SimHidSessions";

/**
 * - `preferred`: the default route for raw input; uses the helper only when it is already
 *   running (and starts it in the background), so the first call never waits for a build.
 * - `fallback`: CtrlProxy is down; start the helper and wait for it.
 */
export type SimHidRouteMode = "preferred" | "fallback";

export interface SimHidRouteOptions {
  mode: SimHidRouteMode;
  signal?: AbortSignal;
  /**
   * Called once the helper reports the input reached (or may have reached) the simulator, never
   * for an `unavailable` outcome, so a caller that falls back to CtrlProxy is not yet dispatched.
   */
  onDispatch?: () => void;
  /**
   * Runs immediately before the command is written to the helper, after the launch settle and any
   * queue wait. A throw (e.g. a stale display fence) aborts the command with nothing sent.
   */
  beforeWrite?: () => void;
}

/** Raw-coordinate and key input for one iOS Simulator through sim-hid-helper (#19118). */
export interface IosSimulatorRawInput {
  tap(
    request: { x: number; y: number; holdMs: number; screen?: SimHidScreenSize },
    options: SimHidRouteOptions,
  ): Promise<SimHidOutcome>;
  swipe(
    request: {
      from: { x: number; y: number };
      to: { x: number; y: number };
      durationMs: number;
      screen?: SimHidScreenSize;
    },
    options: SimHidRouteOptions,
  ): Promise<SimHidOutcome>;
  key(
    key: string,
    modifiers: readonly string[],
    options: SimHidRouteOptions,
  ): Promise<SimHidOutcome>;
  button(button: SimHidButton, options: SimHidRouteOptions): Promise<SimHidOutcome>;
}

/** Keys the helper maps to HID usages; IME-only semantic keys stay on CtrlProxy. */
export const SIM_HID_KEYS: ReadonlySet<string> = new Set([
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right",
  ..."abcdefghijklmnopqrstuvwxyz",
]);

/** Waiting for a helper that must be compiled first (a few seconds of swiftc) when CtrlProxy is down. */
export const SIM_HID_FALLBACK_WAIT_MS = 30_000;
/** SimulatorKit accepts a message in about 1 ms (#19019); the rest is headroom for a loaded host. */
const SIM_HID_REPLY_HEADROOM_MS = 3_000;

export interface SimHidSessionAccess {
  ready: SimHidSessions["ready"];
  acquire: SimHidSessions["acquire"];
}

export class SessionIosSimulatorRawInput implements IosSimulatorRawInput {
  constructor(
    private readonly deviceId: string,
    private readonly sessions: SimHidSessionAccess,
    private readonly launchSettle: Pick<SimHidLaunchSettle, "wait"> = simHidLaunchSettle,
    private readonly fallbackWaitMs: number = SIM_HID_FALLBACK_WAIT_MS,
  ) {}

  tap(
    { x, y, holdMs, screen }: Parameters<IosSimulatorRawInput["tap"]>[0],
    options: SimHidRouteOptions,
  ): Promise<SimHidOutcome> {
    if (!isPortrait(screen)) {
      return Promise.resolve(unsupportedScreen(screen));
    }
    return this.send({ cmd: "tap", x, y, holdMs, ...screen }, holdMs, options, true);
  }

  swipe(
    { from, to, durationMs, screen }: Parameters<IosSimulatorRawInput["swipe"]>[0],
    options: SimHidRouteOptions,
  ): Promise<SimHidOutcome> {
    if (!isPortrait(screen)) {
      return Promise.resolve(unsupportedScreen(screen));
    }
    return this.send(
      { cmd: "swipe", x: from.x, y: from.y, toX: to.x, toY: to.y, durationMs, ...screen },
      durationMs,
      options,
      true,
    );
  }

  key(
    key: string,
    modifiers: readonly string[],
    options: SimHidRouteOptions,
  ): Promise<SimHidOutcome> {
    if (!SIM_HID_KEYS.has(key)) {
      return Promise.resolve({ status: "unavailable", reason: `key ${key} has no HID usage` });
    }
    return this.send({ cmd: "key", key, modifiers: [...modifiers] }, 0, options, false);
  }

  button(button: SimHidButton, options: SimHidRouteOptions): Promise<SimHidOutcome> {
    return this.send({ cmd: "button", button }, 0, options, false);
  }

  private async send(
    command: SimHidCommand,
    gestureMs: number,
    { mode, signal, onDispatch, beforeWrite }: SimHidRouteOptions,
    touch: boolean,
  ): Promise<SimHidOutcome> {
    throwIfAborted(signal);
    const client =
      mode === "preferred"
        ? this.sessions.ready(this.deviceId)
        : await this.sessions.acquire(this.deviceId, this.fallbackWaitMs);
    if (!client) {
      return { status: "unavailable", reason: "sim-hid-helper is not running for this simulator" };
    }
    if (touch) {
      await this.launchSettle.wait(this.deviceId);
    }
    throwIfAborted(signal);
    const outcome = await client.send(command, gestureMs + SIM_HID_REPLY_HEADROOM_MS, () => {
      throwIfAborted(signal);
      beforeWrite?.();
    });
    if (outcome.status !== "unavailable") {
      onDispatch?.();
    }
    return outcome;
  }
}

/**
 * The helper normalizes touches to the screen it is given. A landscape layout would need a
 * rotation to the portrait digitizer, which is not verified yet, so it stays on CtrlProxy. An
 * upside-down portrait has a portrait shape but a mirrored digitizer: callers drop the screen for
 * any observed rotation other than 0 (`simHidScreenFromObservation`).
 */
function isPortrait(screen: SimHidScreenSize | undefined): screen is SimHidScreenSize {
  return screen !== undefined && screen.width > 0 && screen.height >= screen.width;
}

function unsupportedScreen(screen: SimHidScreenSize | undefined): SimHidOutcome {
  return {
    status: "unavailable",
    reason: screen ? "landscape layouts use CtrlProxy" : "screen size or rotation unsupported",
  };
}

export const daemonSimHidSessions = new SimHidSessions({
  // Unit tests inject their own sessions; the shared one must never compile or spawn the helper.
  enabled: () =>
    !readEnvBool(ENV.DISABLE_IOS_SIM_HID) && readEnvRaw(AMBIENT_ENV.NODE_ENV) !== "test",
  provider: new DefaultSimHidHelperProvider(),
  launcher: new DefaultSimHidProcessLauncher(),
  idGenerator: defaultIdGenerator,
  timer: defaultTimer,
});

export function isSimHidDevice(device: Pick<BootedDevice, "platform" | "deviceId">): boolean {
  return (
    device.platform === "ios" && resolveIosDeviceKind({ deviceId: device.deviceId }) === "simulator"
  );
}

/** The HID route for an iOS Simulator; undefined for every other device. */
export function iosSimulatorRawInputFor(
  device: Pick<BootedDevice, "platform" | "deviceId">,
  sessions: SimHidSessionAccess = daemonSimHidSessions,
): IosSimulatorRawInput | undefined {
  return isSimHidDevice(device)
    ? new SessionIosSimulatorRawInput(device.deviceId, sessions)
    : undefined;
}
