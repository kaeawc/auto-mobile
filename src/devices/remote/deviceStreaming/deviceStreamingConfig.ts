/**
 * Builds the Device Streaming {@link RemoteDeviceProvider} from caller configuration (#14468).
 * Nothing is built without an explicit opt-in: remote minutes are billed to the configured
 * Google Cloud project.
 */
import { ActionableError } from "../../../models/ActionableError";
import type { HostCommandExecutor } from "../../../utils/HostCommandExecutor";
import type { IdGenerator } from "../../../utils/IdGenerator";
import type { Timer } from "../../../utils/SystemTimer";
import type { RemoteDeviceGuards } from "../remoteDeviceCostPolicy";
import type { RemoteDeviceProvider } from "../remoteDeviceProvider";
import { RestDeviceStreamingApi, type AccessTokenProvider } from "./DeviceStreamingApi";
import { DeviceStreamingRemoteDeviceProvider } from "./DeviceStreamingRemoteDeviceProvider";
import { GcloudAccessTokenProvider } from "./GcloudAccessTokenProvider";

/** Session cap when the caller opts in without naming one. */
export const DEFAULT_MAX_SESSION_MINUTES = 30;

export interface DeviceStreamingConfig {
  /** Must be true; remote minutes are billed. */
  optIn: boolean;
  /** Google Cloud project billed for sessions. */
  projectId?: string;
  /** Upper bound on one session's total length, extensions included. */
  maxSessionMinutes?: number;
}

export interface ResolvedDeviceStreamingConfig {
  projectId: string;
  guards: RemoteDeviceGuards;
}

/** Optional `domain:` prefix, then 6-30 lowercase letters, digits or hyphens starting with a letter. */
const PROJECT_ID = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Validates the configuration, or throws an error that says which setting to fix. */
export function resolveDeviceStreamingConfig(
  config: DeviceStreamingConfig,
): ResolvedDeviceStreamingConfig {
  if (!config.optIn) {
    throw new ActionableError(
      "Android Device Streaming is billed to your Google Cloud project and is off by default. " +
        "Opt in explicitly to rent a remote device.",
    );
  }
  const projectId = config.projectId?.trim() ?? "";
  if (!PROJECT_ID.test(projectId)) {
    throw new ActionableError(
      projectId.length === 0
        ? "Android Device Streaming needs the Google Cloud project id to bill sessions to."
        : `"${projectId}" is not a Google Cloud project id (6-30 lowercase letters, digits or hyphens).`,
    );
  }
  const maxSessionMinutes = config.maxSessionMinutes ?? DEFAULT_MAX_SESSION_MINUTES;
  if (!Number.isInteger(maxSessionMinutes) || maxSessionMinutes <= 0) {
    throw new ActionableError(
      `The remote session cap must be a positive whole number of minutes, got ${maxSessionMinutes}.`,
    );
  }
  return { projectId, guards: { optIn: true, maxSessionMinutes } };
}

export interface DeviceStreamingProviderDependencies {
  host: HostCommandExecutor;
  timer: Timer;
  /** Defaults to {@link GcloudAccessTokenProvider} over `host`. */
  tokens?: AccessTokenProvider;
  ids?: IdGenerator;
}

export function createDeviceStreamingProvider(
  config: DeviceStreamingConfig,
  deps: DeviceStreamingProviderDependencies,
): RemoteDeviceProvider {
  const { projectId, guards } = resolveDeviceStreamingConfig(config);
  const tokens =
    deps.tokens ?? new GcloudAccessTokenProvider({ host: deps.host, timer: deps.timer });
  const api = new RestDeviceStreamingApi({ tokens, timer: deps.timer });
  return new DeviceStreamingRemoteDeviceProvider({
    api,
    projectId,
    guards,
    timer: deps.timer,
    ids: deps.ids,
  });
}
