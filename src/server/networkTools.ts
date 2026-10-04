import { z } from "zod/v4";
import { validateHeaderName } from "node:http";
import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { NetworkState, type SimulatedErrorType } from "./NetworkState";
import { buildNetworkMockRules } from "./networkMockRules";
import { getNetworkEvents } from "../db/networkEventRepository";
import { buildNetworkGraph } from "./networkGraph";
import { serverConfig } from "../utils/ServerConfig";
import { isIosCtrlProxyOverrideUsableSync } from "../utils/iosCtrlProxyOverride";
import { ActionableError } from "../models";
import { defaultTimer } from "../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
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
    // Use limit (not remaining): device-side stores track consumption and
    // reconnect restores all retained rules from NetworkState.
    return syncAndroidNetworkMessage(device, {
      type: "set_network_mock_rules",
      rules: buildNetworkMockRules(state),
    });
  }
  try {
    if (device.platform === "ios") {
      await IOSCtrlProxyClient.getInstance(device).syncNetworkMockRulesIfAvailable();
    }
  } catch (error) {
    logger.warn(
      `[networkTools] Failed to sync mock rules to device: ${errorMessage(error)}`,
      error,
    );
  }
  return { synced: true };
}

async function syncErrorSimulationToDevice(
  device: BootedDevice,
  state: NetworkState,
): Promise<DeviceSyncResult> {
  if (device.platform !== "android" && device.platform !== "ios") {
    return { synced: true };
  }
  const sim = state.simulation;
  if (device.platform === "ios") {
    const result = await IOSCtrlProxyClient.getInstance(device).setNetworkErrorSimulation({
      enabled: sim !== null,
      errorType: sim?.errorType ?? null,
      limit: sim?.limit ?? null,
      expiresAtEpochMs: sim?.expiresAt ?? null,
    });
    if (!result.success) {
      throw new ActionableError(result.error ?? "Failed to sync iOS network error simulation.");
    }
    return { synced: true };
  }

  return syncAndroidNetworkMessage(device, {
    type: "set_network_error_simulation",
    enabled: sim !== null,
    errorType: sim?.errorType ?? null,
    limit: sim?.limit ?? null,
    expiresAtEpochMs: sim?.expiresAt ?? null,
  });
}

async function setIosErrorSimulation(
  device: BootedDevice,
  state: NetworkState,
  config: { errorType: SimulatedErrorType; durationSeconds: number; limit: number | null } | null,
): Promise<void> {
  if (config === null) {
    state.cancelSimulation();
  }

  const expiresAtEpochMs = config
    ? Math.ceil(state.timer.now() + config.durationSeconds * 1000)
    : null;
  const result = await IOSCtrlProxyClient.getInstance(device).setNetworkErrorSimulation({
    enabled: config !== null,
    errorType: config?.errorType ?? null,
    limit: config?.limit ?? null,
    expiresAtEpochMs,
  });
  if (!result.success) {
    throw new ActionableError(result.error ?? "Failed to sync iOS network error simulation.");
  }

  if (config === null) {
    return;
  }
  state.startSimulationUntil(config.errorType, expiresAtEpochMs!, config.limit);
}

export function registerNetworkTools(): void {
  const state = NetworkState.getInstance();

  // --- network ---
  ToolRegistry.registerDeviceAware(
    "network",
    "Control network capture and error simulation.",
    networkSchema,
    async (device, args: NetworkArgs) => {
      let syncResult: DeviceSyncResult = { synced: true };
      if (args.capture !== undefined) {
        state.setCapture(args.capture);
      }

      if (args.simulateErrors !== undefined) {
        if (device.platform === "ios") {
          if (args.simulateErrors.cancel) {
            if (isIosNetworkErrorSimulationAvailable()) {
              await setIosErrorSimulation(device, state, null);
            } else {
              state.cancelSimulation();
            }
          } else {
            assertIosNetworkErrorSimulationAvailable();
            if (!args.simulateErrors.durationSeconds) {
              throw new ActionableError("durationSeconds is required unless cancel is true");
            }
            await setIosErrorSimulation(device, state, {
              errorType: args.simulateErrors.errorType ?? "http500",
              durationSeconds: args.simulateErrors.durationSeconds,
              limit: args.simulateErrors.limit ?? null,
            });
          }
        } else {
          if (args.simulateErrors.cancel) {
            state.cancelSimulation();
          } else {
            if (!args.simulateErrors.durationSeconds) {
              throw new ActionableError("durationSeconds is required unless cancel is true");
            }
            const errorType: SimulatedErrorType = args.simulateErrors.errorType ?? "http500";
            state.startSimulation(
              errorType,
              args.simulateErrors.durationSeconds,
              args.simulateErrors.limit ?? null,
            );
          }
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

      return createJSONToolResponse({ ...state.getSnapshot(), ...deviceSyncFields(syncResult) });
    },
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

      const mock = state.addMock({
        host: args.host,
        path: args.path,
        method: args.method ?? "*",
        limit: args.limit ?? null,
        remaining: args.limit ?? null,
        statusCode: args.statusCode ?? 200,
        responseHeaders: args.responseHeaders ?? {},
        responseBody: args.responseBody ?? "",
        contentType: args.contentType ?? "application/json",
      });

      const syncResult = await syncMockRulesToDevice(device, state);

      return createJSONToolResponse({
        mockId: mock.mockId,
        mocked: state.getMockSummary(),
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
        cleared = state.removeMock(args.mockId) ? 1 : 0;
        if (cleared === 0) {
          throw new ActionableError(`Mock '${args.mockId}' not found`);
        }
      } else {
        cleared = state.clearAllMocks();
      }

      const syncResult = await syncMockRulesToDevice(device, state);

      return createJSONToolResponse({
        cleared,
        remaining: state.getMockSummary(),
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
