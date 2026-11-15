/**
 * Composition of remote device acquisition from the environment (#14468). Nothing is built
 * unless `AUTOMOBILE_DEVICE_STREAMING` opts in; an opted-in but invalid configuration throws so
 * the caller sees which setting to fix rather than silently losing remote devices.
 */
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { AndroidCtrlProxyRemoteInstaller } from "./androidCtrlProxyRemoteInstaller";
import { AndroidRemoteDeviceConnectSetup } from "./androidRemoteDeviceConnectSetup";
import {
  createDeviceStreamingProvider,
  readDeviceStreamingConfig,
  resolveDeviceStreamingConfig,
  type DeviceStreamingConfig,
  type DeviceStreamingProviderDependencies,
} from "./deviceStreaming/deviceStreamingConfig";
import {
  RemoteDeviceAcquisition,
  type RemoteAdbTransport,
  type RemoteDeviceConnectSetup,
} from "./remoteDeviceAcquisition";
import type { RemoteDeviceProvider } from "./remoteDeviceProvider";

export interface RemoteDeviceAcquisitionFactoryDependencies {
  host: HostCommandExecutor;
  timer: Timer;
  /** The adb bridge to reserved devices (#14464). */
  transport: RemoteAdbTransport;
  env?: NodeJS.ProcessEnv;
  /** Defaults to Android setup over `AndroidCtrlProxyManager`. */
  setup?: RemoteDeviceConnectSetup;
  /** Defaults to the Device Streaming REST provider. */
  createProvider?: (
    config: DeviceStreamingConfig,
    deps: DeviceStreamingProviderDependencies,
  ) => RemoteDeviceProvider;
}

/** The acquisition to hand the broker, or undefined when Device Streaming is not opted in. */
export function createRemoteDeviceAcquisitionFromEnv(
  deps: RemoteDeviceAcquisitionFactoryDependencies,
): RemoteDeviceAcquisition | undefined {
  const config = readDeviceStreamingConfig(deps.env);
  if (!config.optIn) {
    return undefined;
  }
  // Validated here too, so a substituted provider cannot bypass the project id and cap checks.
  resolveDeviceStreamingConfig(config);
  const createProvider = deps.createProvider ?? createDeviceStreamingProvider;
  const provider = createProvider(config, { host: deps.host, timer: deps.timer });
  return new RemoteDeviceAcquisition({
    provider,
    transport: deps.transport,
    setup:
      deps.setup ??
      new AndroidRemoteDeviceConnectSetup({ ctrlProxy: new AndroidCtrlProxyRemoteInstaller() }),
    timer: deps.timer,
  });
}
