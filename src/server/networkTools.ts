import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { NetworkState, type SimulatedErrorType } from "./NetworkState";
import { getNetworkEvents } from "../db/networkEventRepository";
import { buildNetworkGraph } from "./networkGraph";
import { serverConfig } from "../utils/ServerConfig";
import { ActionableError } from "../models";
import { defaultTimer } from "../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import type { BootedDevice } from "../utils/deviceUtils";
import { logger } from "../utils/logger";

// --- network tool ---

const simulateErrorsSchema = z.object({
  errorType: z
    .enum(["http500", "timeout", "connectionRefused", "dnsFailure", "tlsFailure"])
    .optional()
    .describe("Error type; default http500"),
  limit: z.number().int().positive().optional().describe("Max errors"),
  durationSeconds: z.number().positive().optional().describe("Simulation duration seconds"),
  cancel: z.boolean().optional().describe("Cancel active simulation"),
}).superRefine((value, ctx) => {
  if (value.cancel !== true && value.durationSeconds === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["durationSeconds"],
      message: "durationSeconds is required unless cancel is true",
    });
  }
});

const networkSchema = addDeviceTargetingToSchema(
  z.object({
    capture: z.boolean().optional().describe("Toggle capture"),
    simulateErrors: simulateErrorsSchema
      .optional()
      .describe("Error simulation settings"),
    notifFilter: z
      .enum(["all", "errors", "slow"])
      .optional()
      .describe("Notification filter"),
    notifDebounceMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Notification debounce ms"),
    slowThresholdMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Slow threshold ms"),
  })
);

type NetworkArgs = z.infer<typeof networkSchema>;

// --- mockNetwork tool ---

const mockNetworkSchema = addDeviceTargetingToSchema(
  z.object({
    host: z.string().describe("Host pattern (regex)"),
    path: z.string().describe("Path pattern (regex)"),
    method: z.string().optional().describe("HTTP method; default *"),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Mock response limit"),
    statusCode: z.number().int().min(100).max(599).optional().describe("Response status; default 200"),
    responseHeaders: z
      .record(z.string(), z.string())
      .optional()
      .describe("Response headers"),
    responseBody: z.string().optional().describe("Response body (max 10KB)"),
    contentType: z.string().optional().describe("Content-Type; default application/json"),
  })
);

type MockNetworkArgs = z.infer<typeof mockNetworkSchema>;

// --- clearMockNetwork tool ---

const clearMockNetworkSchema = addDeviceTargetingToSchema(
  z.object({
    mockId: z.string().optional().describe("Mock ID; omit to clear all"),
  })
);

type ClearMockNetworkArgs = z.infer<typeof clearMockNetworkSchema>;

// --- getNetworkGraph tool ---

const getNetworkGraphSchema = addDeviceTargetingToSchema(
  z.object({
    sinceSeconds: z
      .number()
      .positive()
      .optional()
      .describe("Lookback seconds"),
    method: z.string().optional().describe("Filter by HTTP method"),
    minRequests: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Minimum request count"),
  })
);

type GetNetworkGraphArgs = z.infer<typeof getNetworkGraphSchema>;

function syncMockRulesToDevice(device: BootedDevice, state: NetworkState): void {
  if (device.platform !== "android" && device.platform !== "ios") {return;}
  try {
    const client = device.platform === "android"
      ? AndroidCtrlProxyClient.getInstance(device)
      : IOSCtrlProxyClient.getInstance(device);
    // Use limit (not remaining) since the server never tracks consumption —
    // the device-side NetworkMockRuleStore manages its own remaining count
    const rules = Array.from(state.getMocks().values()).map(r => ({
      mockId: r.mockId,
      host: r.host,
      path: r.path,
      method: r.method,
      limit: r.limit,
      remaining: r.limit,
      statusCode: r.statusCode,
      responseHeaders: r.responseHeaders,
      responseBody: r.responseBody,
      contentType: r.contentType,
    }));
    const msg = JSON.stringify({ type: "set_network_mock_rules", rules });
    const sent = client.sendMessage(msg);
    logger.info(`[networkTools] syncMockRules(${device.platform}): ${rules.length} rules, sent=${sent}`);
  } catch (e) {
    logger.info(`[networkTools] Failed to sync mock rules to device: ${e}`);
  }
}

function syncErrorSimulationToDevice(device: BootedDevice, state: NetworkState): void {
  if (device.platform !== "android") {return;}
  try {
    const client = AndroidCtrlProxyClient.getInstance(device);
    const sim = state.simulation;
    client.sendMessage(JSON.stringify({
      type: "set_network_error_simulation",
      enabled: sim !== null,
      errorType: sim?.errorType ?? null,
      limit: sim?.limit ?? null,
      expiresAtEpochMs: sim?.expiresAt ?? null,
    }));
  } catch (e) {
    logger.debug(`[networkTools] Failed to sync error simulation to device: ${e}`);
  }
}

export function registerNetworkTools(): void {
  const state = NetworkState.getInstance();

  // --- network ---
  ToolRegistry.registerDeviceAware(
    "network",
    "Control network capture and error simulation.",
    networkSchema,
    async (device, args: NetworkArgs) => {
      if (args.capture !== undefined) {
        state.setCapture(args.capture);
      }

      if (args.simulateErrors !== undefined) {
        if (device.platform !== "android") {
          throw new ActionableError(
            "Network error simulation is only supported on Android devices."
          );
        }
        if (args.simulateErrors.cancel) {
          state.cancelSimulation();
        } else {
          if (!args.simulateErrors.durationSeconds) {
            throw new ActionableError("durationSeconds is required unless cancel is true");
          }
          const errorType: SimulatedErrorType =
            args.simulateErrors.errorType ?? "http500";
          state.startSimulation(
            errorType,
            args.simulateErrors.durationSeconds,
            args.simulateErrors.limit ?? null
          );
        }
        syncErrorSimulationToDevice(device, state);
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

      return createJSONToolResponse(state.getSnapshot());
    },
    false,
    false,
    { embeddedSdkOnly: true }
  );

  // --- mockNetwork ---
  ToolRegistry.registerDeviceAware(
    "mockNetwork",
    "Add mock network response rule.",
    mockNetworkSchema,
    async (device, args: MockNetworkArgs) => {
      if (!serverConfig.isNetworkMockableEnabled()) {
        throw new ActionableError(
          "Network mocking is disabled. Start the server with --network-mockable to enable."
        );
      }
      if (device.platform !== "android" && device.platform !== "ios") {
        throw new ActionableError(
          "Network mocking is only supported on Android and iOS devices."
        );
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

      syncMockRulesToDevice(device, state);

      return createJSONToolResponse({
        mockId: mock.mockId,
        mocked: state.getMockSummary(),
      });
    },
    false,
    false,
    { embeddedSdkOnly: true }
  );

  // --- clearMockNetwork ---
  ToolRegistry.registerDeviceAware(
    "clearMockNetwork",
    "Clear mock network response rules.",
    clearMockNetworkSchema,
    async (device, args: ClearMockNetworkArgs) => {
      if (!serverConfig.isNetworkMockableEnabled()) {
        throw new ActionableError(
          "Network mocking is disabled. Start the server with --network-mockable to enable."
        );
      }
      if (device.platform !== "android" && device.platform !== "ios") {
        throw new ActionableError(
          "Network mocking is only supported on Android and iOS devices."
        );
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

      syncMockRulesToDevice(device, state);

      return createJSONToolResponse({
        cleared,
        remaining: state.getMockSummary(),
      });
    },
    false,
    false,
    { embeddedSdkOnly: true }
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
        limit: 10_000,
      });

      const graph = buildNetworkGraph(events, {
        minRequests: args.minRequests,
      });

      return createJSONToolResponse(graph);
    },
    false,
    false,
    { embeddedSdkOnly: true }
  );
}
