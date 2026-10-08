import type { OverlayAgentClient } from "./ios/overlayAgentClient";

/**
 * The open overlay-agent connection for a device, recorded by `launchApp {overlay: true}`
 * (#10567) and consumed by the overlay tool (#10568). A relaunch replaces the client object;
 * a closed connection, terminateApp or a session release removes it.
 */
export interface OverlayAgentConnections {
  get(deviceId: string): OverlayAgentClient | undefined;
}

/** No injected agents: every device falls back to the platform's own overlay path. */
export const noOverlayAgentConnections: OverlayAgentConnections = {
  get: () => undefined,
};
