import type { BootedDevice } from "../../models";
import type { CtrlProxyClient } from "../../features/observe/interfaces/CtrlProxyClient";
import type { NotificationUIDetector } from "./NotificationUIDetector";
import type { SystemConfigurationAdapter } from "./SystemConfigurationAdapter";
import type { TapStrategy } from "./TapStrategy";

/**
 * Facade that bundles the platform-specific handles a tool typically
 * needs into a single object. Established in PRs #2182, #2249, #2251,
 * #2253 and #2257, each interface in this bundle replaces one
 * `device.platform === ...` branch inside a feature. Composing them
 * here lets a tool wire dependencies via a single dispatch point.
 *
 * Why a facade rather than five constructor args: most call sites need
 * the same combination (ctrlProxy + tapStrategy + systemConfiguration +
 * notificationUI), so threading them individually leaks platform-
 * dispatch concerns into every constructor. This PR establishes only
 * the type and a default factory; existing call sites are migrated by
 * follow-ups.
 */
export interface PlatformClient {
  /** The device this client is bound to. */
  readonly device: BootedDevice;

  /** Platform-appropriate CtrlProxy client (Android / iOS). */
  readonly ctrlProxy: CtrlProxyClient;

  /** Platform-appropriate tap strategy. See PR #2251. */
  readonly tapStrategy: TapStrategy;

  /** Platform-appropriate system-configuration adapter. See PR #2253. */
  readonly systemConfiguration: SystemConfigurationAdapter;

  /** Platform-appropriate notification-UI detector. See PR #2257. */
  readonly notificationUI: NotificationUIDetector;
}
