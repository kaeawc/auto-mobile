import type { IosSimulatorNetworkShaper } from "../ios/IosSimulatorNetworkShaper";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import {
  classifyNetworkConditionRequest,
  NETWORK_CONDITION_EMPTY_REQUEST_ERROR,
  NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR,
  NETWORK_CONDITION_PROFILES,
  resolveNetworkProfile,
  resolveNetworkValues,
  type NetworkConditionState,
  type SetNetworkConditionInput,
} from "./NetworkConditionState";

/** Shown when applying shaping first rebooted the simulator. */
export const IOS_SHAPER_REBOOT_WARNING =
  "The simulator was rebooted once with the network shaper in its launchd environment, so " +
  "running apps were terminated; relaunch the app under test. Later changes apply live.";

/** What the device-wide socket shaper covers and does not (#19045). */
export const IOS_SHAPER_LIMITATIONS: readonly string[] = Object.freeze([
  "Shapes the processes in the simulator that load the shaper (the app, WebKit and most system daemons; a few simulator processes do not load it), for connections to non-loopback peers; loopback traffic (CtrlProxy) is never shaped.",
  "packetLossPercent is the percent of new TCP connections that time out and of UDP datagrams dropped.",
  "Latency is added to the connection handshake and to each request/response turnaround; HTTP/2 and TLS setup can count it more than once.",
]);

/**
 * Device-wide iOS Simulator network condition through the boot-injected socket
 * shaper (#19045): no network extension, root or MDM.
 */
export async function applyIosShaperNetworkCondition(
  shaper: IosSimulatorNetworkShaper,
  udid: string,
  input: SetNetworkConditionInput,
): Promise<NetworkConditionState> {
  const profile = resolveNetworkProfile(input);
  const kind = classifyNetworkConditionRequest(input);
  const expires =
    input.expiresInSeconds !== undefined ? { expiresInSeconds: input.expiresInSeconds } : {};
  const base: NetworkConditionState = {
    supported: true,
    capability: "full",
    backend: "socket-shaper",
    scope: "device",
    requestedProfile: profile,
    ...expires,
  };
  if (kind === "empty" || kind === "invalid") {
    return {
      ...base,
      supported: false,
      capability: "unsupported",
      values: NETWORK_CONDITION_PROFILES[profile],
      verified: false,
      error:
        kind === "invalid"
          ? NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR
          : NETWORK_CONDITION_EMPTY_REQUEST_ERROR,
    };
  }
  if (kind === "reset") {
    try {
      await shaper.clear(udid);
    } catch (error) {
      logger.warn(`[DeviceState] iOS network shaper reset failed: ${errorMessage(error)}`, error);
      return { ...base, verified: false, error: errorMessage(error) };
    }
    return {
      ...base,
      profile: "none",
      appliedProfile: "none",
      values: NETWORK_CONDITION_PROFILES.none,
      verified: true,
    };
  }
  const values = resolveNetworkValues(profile, input);
  const offline = profile === "offline";
  try {
    const { rebooted } = await shaper.apply(udid, { offline, ...values });
    return {
      ...base,
      profile,
      appliedProfile: profile,
      values,
      rebooted,
      limitations: [...IOS_SHAPER_LIMITATIONS],
      ...(rebooted ? { warning: IOS_SHAPER_REBOOT_WARNING } : {}),
    };
  } catch (error) {
    logger.warn(`[DeviceState] iOS network shaper apply failed: ${errorMessage(error)}`, error);
    return { ...base, values, verified: false, error: errorMessage(error) };
  }
}

/**
 * The shaper's state for a read, or undefined when AutoMobile never shaped this simulator.
 * A failed read is a socket-shaper state with an error, not a fall-through to the extension.
 */
export async function readIosShaperNetworkCondition(
  shaper: IosSimulatorNetworkShaper,
  udid: string,
): Promise<NetworkConditionState | undefined> {
  let state;
  try {
    state = await shaper.read(udid);
  } catch (error) {
    logger.warn(`[DeviceState] iOS network shaper read failed: ${errorMessage(error)}`, error);
    return {
      supported: true,
      capability: "full",
      backend: "socket-shaper",
      scope: "device",
      error: errorMessage(error),
    };
  }
  if (!state.injected || !state.profile) {
    return undefined;
  }
  const { offline, ...values } = state.profile;
  return {
    supported: true,
    capability: "full",
    backend: "socket-shaper",
    scope: "device",
    offline,
    values,
    limitations: [...IOS_SHAPER_LIMITATIONS],
  };
}
