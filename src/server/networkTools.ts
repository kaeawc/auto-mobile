import { z } from "zod/v4";
import { validateHeaderName } from "node:http";
import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import {
  NetworkState,
  simulationRemainingMs,
  type SimulatedErrorType,
  type SimulationConfig,
} from "./NetworkState";
import { buildNetworkMockRules } from "./networkMockRules";
import { getNetworkEvents } from "../db/networkEventRepository";
import { buildNetworkGraph } from "./networkGraph";
import { serverConfig } from "../utils/ServerConfig";
import { isIosCtrlProxyOverrideUsableSync } from "../utils/iosCtrlProxyOverride";
import { ActionableError } from "../models";
import { defaultTimer } from "../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient, type IosMockRuleSyncOutcome } from "../features/observe/ios";
import type { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  LATEST_RELEASE_VERSION,
  RELEASE_CHECKSUM_REGISTRY,
  resolveAssetVersion,
  resolvePinnedVersion,
  isPinnedVersionKnown,
  type ReleaseChecksumEntry,
} from "../constants/release";

// --- network tool ---

export const IOS_NETWORK_ERROR_SIMULATION_MIN_RELEASE = "0.0.41";

const simulateErrorsSchema = z
  .object({
    errorType: z
      .enum(["http500", "timeout", "connectionRefused", "dnsFailure", "tlsFailure"])
      .optional()
      .describe("Error type; default http500"),
    limit: z.number().int().positive().optional().describe("Max errors"),
    durationSeconds: z.number().positive().optional().describe("Simulation duration seconds"),
    cancel: z.boolean().optional().describe("Cancel active simulation"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cancel !== true && value.durationSeconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "durationSeconds is required unless cancel is true",
      });
    }
  });

const networkSchema = addDeviceTargetingToSchema(
  z
    .object({
      capture: z.boolean().optional().describe("Toggle capture"),
      simulateErrors: simulateErrorsSchema.optional().describe("Error simulation settings"),
      notifFilter: z.enum(["all", "errors", "slow"]).optional().describe("Notification filter"),
      notifDebounceMs: z.number().int().min(0).optional().describe("Notification debounce ms"),
      slowThresholdMs: z.number().int().positive().optional().describe("Slow threshold ms"),
    })
    .strict(),
);

type NetworkArgs = z.infer<typeof networkSchema>;

// --- mockNetwork tool ---

const mockNetworkSchema = addDeviceTargetingToSchema(
  z
    .object({
      host: z.string().describe("Host pattern (regex)"),
      path: z.string().describe("Path pattern (regex)"),
      method: z.string().optional().describe("HTTP method; default *"),
      limit: z.number().int().positive().optional().describe("Mock response limit"),
      statusCode: z
        .number()
        .int()
        .min(100)
        .max(599)
        .optional()
        .describe("Response status; default 200"),
      responseHeaders: z.record(z.string(), z.string()).optional().describe("Response headers"),
      responseBody: z.string().optional().describe("Response body (max 10KB)"),
      contentType: z.string().optional().describe("Content-Type; default application/json"),
    })
    .strict(),
);

type MockNetworkArgs = z.infer<typeof mockNetworkSchema>;

function assertValidResponseHeaders(responseHeaders: Record<string, string> | undefined): void {
  if (responseHeaders === undefined) {
    return;
  }

  for (const [name, value] of Object.entries(responseHeaders)) {
    try {
      validateHeaderName(name);
    } catch (error) {
      throw new ActionableError(`Invalid mock response header '${name}': ${errorMessage(error)}`);
    }
    if (!/^[\t\x20-\x7e]*$/.test(value)) {
      throw new ActionableError(`Invalid mock response header '${name}': value must be ASCII`);
    }
  }
}

// --- clearMockNetwork tool ---

const clearMockNetworkSchema = addDeviceTargetingToSchema(
  z
    .object({
      mockId: z.string().optional().describe("Mock ID; omit to clear all"),
    })
    .strict(),
);

type ClearMockNetworkArgs = z.infer<typeof clearMockNetworkSchema>;

// --- getNetworkGraph tool ---

const getNetworkGraphSchema = addDeviceTargetingToSchema(
  z
    .object({
      sinceSeconds: z.number().positive().optional().describe("Lookback seconds"),
      method: z.string().optional().describe("Filter by HTTP method"),
      minRequests: z.number().int().min(1).optional().describe("Minimum request count"),
    })
    .strict(),
);

type GetNetworkGraphArgs = z.infer<typeof getNetworkGraphSchema>;

const NETWORK_GRAPH_MAX_EVENTS = 10_000;

type DeviceSyncResult = { synced: true } | { synced: false; warning: string };

function deviceSyncFields(result: DeviceSyncResult): { deviceSynced?: false; warning?: string } {
  return result.synced ? {} : { deviceSynced: false, warning: result.warning };
}

function syncAndroidNetworkMessage(
  device: BootedDevice,
  message: Record<string, unknown>,
): DeviceSyncResult {
  const warning =
    "Network state is stored but was not synced to the device; it will be applied when the " +
    "device connection is restored (error simulation keeps its original expiry).";
  try {
    if (AndroidCtrlProxyClient.getInstance(device).sendMessage(JSON.stringify(message))) {
      return { synced: true };
    }
    logger.warn(`[networkTools] ${warning}`);
  } catch (error) {
    logger.warn(`[networkTools] Failed to sync network state: ${errorMessage(error)}`, error);
  }
  return { synced: false, warning };
}

function compareDottedVersion(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number(part));
  const bParts = b.split(".").map((part) => Number(part));
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const left = Number.isFinite(aParts[i]) ? aParts[i] : 0;
    const right = Number.isFinite(bParts[i]) ? bParts[i] : 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

function hasIosCtrlProxyRunnerOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  // A non-empty string is not enough: a directory or a missing path resolves to
  // no runnable artifact, so treating it as "capability present" made mockNetwork
  // bypass its min-release gate on the strength of a value that never loads
  // (#4221). Require the override to resolve to a real .ipa file.
  return isIosCtrlProxyOverrideUsableSync(env);
}

export function isIosNetworkErrorSimulationAvailable(
  env: NodeJS.ProcessEnv = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): boolean {
  if (hasIosCtrlProxyRunnerOverride(env)) {
    return true;
  }

  const pinned = resolvePinnedVersion(env);
  if (pinned !== LATEST_RELEASE_VERSION && !isPinnedVersionKnown(env, registry)) {
    return false;
  }

  return (
    compareDottedVersion(
      resolveAssetVersion(pinned, registry),
      IOS_NETWORK_ERROR_SIMULATION_MIN_RELEASE,
    ) >= 0
  );
}

function assertIosNetworkErrorSimulationAvailable(): void {
  if (isIosNetworkErrorSimulationAvailable()) {
    return;
  }
  const resolvedVersion = resolveAssetVersion(resolvePinnedVersion());
  throw new ActionableError(
    `Network error simulation is not enabled for the bundled iOS CtrlProxy runner ` +
      `(${resolvedVersion}); it requires iOS CtrlProxy ${IOS_NETWORK_ERROR_SIMULATION_MIN_RELEASE} ` +
      `or newer with set_network_error_simulation. Use Android for this scenario, ` +
      `provide a locally built iOS runner via AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH or ` +
      `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH, or retry after the updated runner ships.`,
  );
}

async function syncMockRulesToDevice(
  device: BootedDevice,
  state: NetworkState,
): Promise<DeviceSyncResult> {
  if (device.platform === "android") {
    // This device's rules only (#10061). Device-side stores keep consumption per
    // mockId across a re-push (#10060), so resending the full list is safe.
    return syncAndroidNetworkMessage(device, {
      type: "set_network_mock_rules",
      rules: buildNetworkMockRules(state, device.deviceId),
    });
  }
  if (device.platform !== "ios") {
    return { synced: true };
  }
  return syncIosMockRules(device);
}

const IOS_MOCK_SYNC_PENDING = "will be applied when the device connection is restored";

const IOS_MOCK_SYNC_WARNINGS: Record<Exclude<IosMockRuleSyncOutcome, "sent">, string> = {
  noCapability:
    "Mock rules are stored but were not synced to the device: the foreground app does not " +
    "expose the AutoMobile SDK network_mocking capability. They " +
    IOS_MOCK_SYNC_PENDING +
    " or the app exposes the capability.",
  disabled: "Mock rules are stored but were not synced to the device: network mocking is disabled.",
  failed:
    "Mock rules are stored but were not synced to the device; they " + IOS_MOCK_SYNC_PENDING + ".",
  superseded:
    "Mock rules are stored but were not synced to the device: the sync was superseded by a " +
    "newer foreground-app capability probe. They " +
    IOS_MOCK_SYNC_PENDING +
    ".",
};

async function syncIosMockRules(device: BootedDevice): Promise<DeviceSyncResult> {
  try {
    const outcome = await IOSCtrlProxyClient.getInstance(device).syncNetworkMockRulesIfAvailable();
    if (outcome === "sent") {
      return { synced: true };
    }
    const warning = IOS_MOCK_SYNC_WARNINGS[outcome];
    logger.warn(`[networkTools] ${warning}`);
    return { synced: false, warning };
  } catch (error) {
    logger.warn(
      `[networkTools] Failed to sync mock rules to device: ${errorMessage(error)}`,
      error,
    );
    return { synced: false, warning: IOS_MOCK_SYNC_WARNINGS.failed };
  }
}

function errorSimulationMessageFields(sim: SimulationConfig | null, nowMs: number) {
  return {
    enabled: sim !== null,
    errorType: sim?.errorType ?? null,
    limit: sim?.limit ?? null,
    // Host-clock epoch, kept for SDKs that predate remainingMs.
    expiresAtEpochMs: sim?.expiresAt ?? null,
    // New SDKs time the simulation from this on the device's own monotonic clock (#10062).
    remainingMs: sim ? simulationRemainingMs(sim, nowMs) : null,
  };
}

async function syncErrorSimulationToDevice(
  device: BootedDevice,
  state: NetworkState,
): Promise<DeviceSyncResult> {
  if (device.platform !== "android" && device.platform !== "ios") {
    return { synced: true };
  }
  const sim = state.getSimulation(device.deviceId);
  if (device.platform === "ios") {
    const result = await IOSCtrlProxyClient.getInstance(device).setNetworkErrorSimulation(
      errorSimulationMessageFields(sim, state.timer.now()),
    );
    if (!result.success) {
      throw new ActionableError(result.error ?? "Failed to sync iOS network error simulation.");
    }
    return { synced: true };
  }

  return syncAndroidNetworkMessage(device, {
    type: "set_network_error_simulation",
    ...errorSimulationMessageFields(sim, state.timer.now()),
  });
}

async function setIosErrorSimulation(
  device: BootedDevice,
  state: NetworkState,
  config: { errorType: SimulatedErrorType; durationSeconds: number; limit: number | null } | null,
): Promise<void> {
  if (config === null) {
    state.cancelSimulation(device.deviceId);
  }

  const remainingMs = config ? Math.ceil(config.durationSeconds * 1000) : null;
  const expiresAtEpochMs = remainingMs === null ? null : Math.ceil(state.timer.now() + remainingMs);
  const result = await IOSCtrlProxyClient.getInstance(device).setNetworkErrorSimulation({
    enabled: config !== null,
    errorType: config?.errorType ?? null,
    limit: config?.limit ?? null,
    expiresAtEpochMs,
    remainingMs,
  });
  if (!result.success) {
    throw new ActionableError(result.error ?? "Failed to sync iOS network error simulation.");
  }

  if (config === null) {
    return;
  }
  state.startSimulationUntil(device.deviceId, config.errorType, expiresAtEpochMs!, config.limit);
}

function iosSimulationConfig(
  state: NetworkState,
  device: BootedDevice,
  simulation: NonNullable<NetworkArgs["simulateErrors"]>,
) {
  if (simulation.cancel) {
    if (isIosNetworkErrorSimulationAvailable()) {
      return null;
    }
    state.cancelSimulation(device.deviceId);
    return undefined;
  }
  assertIosNetworkErrorSimulationAvailable();
  if (!simulation.durationSeconds) {
    throw new ActionableError("durationSeconds is required unless cancel is true");
  }
  return {
    errorType: simulation.errorType ?? "http500",
    durationSeconds: simulation.durationSeconds,
    limit: simulation.limit ?? null,
  };
}

function updateSimulation(
  state: NetworkState,
  device: BootedDevice,
  simulation: NonNullable<NetworkArgs["simulateErrors"]>,
): void {
  if (simulation.cancel) {
    state.cancelSimulation(device.deviceId);
  } else {
    if (!simulation.durationSeconds) {
      throw new ActionableError("durationSeconds is required unless cancel is true");
    }
    const errorType: SimulatedErrorType = simulation.errorType ?? "http500";
    state.startSimulation(
      device.deviceId,
      errorType,
      simulation.durationSeconds,
      simulation.limit ?? null,
    );
  }
}

function createNetworkHandler(state: NetworkState) {
  return async (device: BootedDevice, args: NetworkArgs) => {
    let syncResult: DeviceSyncResult = { synced: true };
    if (args.capture !== undefined) {
      state.setCapture(args.capture);
    }

    if (args.simulateErrors !== undefined) {
      if (device.platform === "ios") {
        state.noteSessionOwner(device.deviceId, args.sessionUuid);
        const config = iosSimulationConfig(state, device, args.simulateErrors);
        if (config !== undefined) {
          await setIosErrorSimulation(device, state, config);
        }
      } else {
        state.noteSessionOwner(device.deviceId, args.sessionUuid);
        updateSimulation(state, device, args.simulateErrors);
        syncResult = await syncErrorSimulationToDevice(device, state);
      }
    }

    if (args.notifFilter !== undefined) {
      state.setNotifFilter(args.notifFilter);
    }
    if (args.notifDebounceMs !== undefined) {
      state.setNotifDebounceMs(args.notifDebounceMs);
    }
    if (args.slowThresholdMs !== undefined) {
      state.setSlowThresholdMs(args.slowThresholdMs);
    }

    return createJSONToolResponse({
      ...state.getSnapshot(device.deviceId),
      ...deviceSyncFields(syncResult),
    });
  };
}

function mockRuleFields(args: MockNetworkArgs) {
  return {
    host: args.host,
    path: args.path,
    method: args.method ?? "*",
    limit: args.limit ?? null,
    statusCode: args.statusCode ?? 200,
    responseHeaders: args.responseHeaders ?? {},
    responseBody: args.responseBody ?? "",
    contentType: args.contentType ?? "application/json",
  };
}

export function registerNetworkTools(): void {
  const state = NetworkState.getInstance();

  // --- network ---
  ToolRegistry.registerDeviceAware(
    "network",
    "Control network capture and error simulation.",
    networkSchema,
    createNetworkHandler(state),
    { defaultEnabled: false, embeddedSdkOnly: true },
  );

  // --- mockNetwork ---
  ToolRegistry.registerDeviceAware(
    "mockNetwork",
    "Add mock network response rule.",
    mockNetworkSchema,
    async (device, args: MockNetworkArgs) => {
      if (!serverConfig.isNetworkMockableEnabled()) {
        throw new ActionableError(
          "Network mocking is disabled. Start the server with --network-mockable to enable.",
        );
      }
      if (device.platform !== "android" && device.platform !== "ios") {
        throw new ActionableError("Network mocking is only supported on Android and iOS devices.");
      }

      // Validate regex patterns before creating the mock rule
      try {
        new RegExp(args.host);
      } catch {
        throw new ActionableError(`Invalid host regex: ${args.host}`);
      }
      try {
        new RegExp(args.path);
      } catch {
        throw new ActionableError(`Invalid path regex: ${args.path}`);
      }
      assertValidResponseHeaders(args.responseHeaders);

      state.noteSessionOwner(device.deviceId, args.sessionUuid);
      const mock = state.addMock(device.deviceId, mockRuleFields(args));

      const syncResult = await syncMockRulesToDevice(device, state);

      return createJSONToolResponse({
        mockId: mock.mockId,
        mocked: state.getMockSummary(device.deviceId),
        ...deviceSyncFields(syncResult),
      });
    },
    { defaultEnabled: false, embeddedSdkOnly: true },
  );

  // --- clearMockNetwork ---
  ToolRegistry.registerDeviceAware(
    "clearMockNetwork",
    "Clear mock network response rules.",
    clearMockNetworkSchema,
    async (device, args: ClearMockNetworkArgs) => {
      if (!serverConfig.isNetworkMockableEnabled()) {
        throw new ActionableError(
          "Network mocking is disabled. Start the server with --network-mockable to enable.",
        );
      }
      if (device.platform !== "android" && device.platform !== "ios") {
        throw new ActionableError("Network mocking is only supported on Android and iOS devices.");
      }

      let cleared: number;
      if (args.mockId) {
        cleared = state.removeMock(device.deviceId, args.mockId) ? 1 : 0;
        if (cleared === 0) {
          throw new ActionableError(`Mock '${args.mockId}' not found`);
        }
      } else {
        cleared = state.clearAllMocks(device.deviceId);
      }

      const syncResult = await syncMockRulesToDevice(device, state);

      return createJSONToolResponse({
        cleared,
        remaining: state.getMockSummary(device.deviceId),
        ...deviceSyncFields(syncResult),
      });
    },
    { defaultEnabled: false, embeddedSdkOnly: true },
  );

  // --- getNetworkGraph ---
  ToolRegistry.registerDeviceAware(
    "getNetworkGraph",
    "Get aggregate captured network graph.",
    getNetworkGraphSchema,
    async (device, args: GetNetworkGraphArgs) => {
      const sinceTimestamp = args.sinceSeconds
        ? defaultTimer.now() - args.sinceSeconds * 1000
        : undefined;

      const events = await getNetworkEvents({
        deviceId: device.deviceId,
        sinceTimestamp,
        method: args.method,
        limit: NETWORK_GRAPH_MAX_EVENTS + 1,
      });

      const truncated = events.length > NETWORK_GRAPH_MAX_EVENTS;
      // The repository orders newest first; exclude the extra oldest event.
      const graph = buildNetworkGraph(events.slice(0, NETWORK_GRAPH_MAX_EVENTS), {
        minRequests: args.minRequests,
      });

      return createJSONToolResponse({
        ...graph,
        ...(truncated ? { truncated: true, maxEvents: NETWORK_GRAPH_MAX_EVENTS } : {}),
      });
    },
    { defaultEnabled: false, embeddedSdkOnly: true },
  );
}
