import type { BoundSessionLoss } from "../types";
import type { DaemonStateAccess } from "../daemonRequestHandlers";
import { resolveToolSelectionBaseSessionUuid } from "../../features/toolSelection/selectionSessionResolver";
import { DeviceControlTransportRecovery } from "./DeviceControlTransportRecovery";
import { McpForwardRouter, readSessionUuid, type McpForwardRoutePort } from "./McpForwardRouter";

/**
 * Composition of the MCP forward pipeline (#11815): the one place that builds
 * {@link DeviceControlTransportRecovery} and {@link McpForwardRouter} and wires the router's port
 * to the recovery, the daemon's session manager and device pool, and the server-owned lookups.
 * `UnixSocketServer` supplies only the {@link McpForwardPipelineHost} lookups it owns.
 */

/** The daemon state the pipeline reads; each accessor is resolved on every call. */
export interface McpForwardPipelineState {
  getSessionManager(): ReturnType<DaemonStateAccess["getSessionManager"]> & {
    isReleasedSessionInRestartRecoveryWindow?(sessionId: string): Promise<boolean>;
    getExpiredReleaseSnapshot?(sessionId: string): Promise<BoundSessionLoss["release"]>;
  };
  getDevicePool(): {
    resolveOwnedDeviceSessionForMcpSession?(
      mcpSessionId: string | undefined,
      deviceId: string,
    ): string | undefined;
  };
}

/** Server-owned lookups the router needs; everything else is derived from the daemon state. */
export interface McpForwardPipelineHost extends Omit<
  McpForwardRoutePort,
  "withAdmittedBoundSession" | "toolSelectionBaseSession" | "ownedDeviceSessionForMcpSession"
> {
  /** Whether the args name a bound session that was already released. */
  isReleasedBoundSession(args: unknown, socketSessionId?: string): boolean;
}

export interface McpForwardPipeline {
  readonly router: McpForwardRouter;
  readonly recovery: DeviceControlTransportRecovery;
  /** Run `forward`, admitting the session the args name first when it was released. */
  withAdmittedBoundSession: McpForwardRoutePort["withAdmittedBoundSession"];
}

export function createMcpForwardPipeline(
  state: McpForwardPipelineState,
  host: McpForwardPipelineHost,
): McpForwardPipeline {
  const recovery = new DeviceControlTransportRecovery({
    isReleasedSessionInRestartRecoveryWindow: async (sessionUuid) =>
      await state.getSessionManager().isReleasedSessionInRestartRecoveryWindow?.(sessionUuid),
    terminalReleaseSnapshot: (sessionUuid) =>
      state.getSessionManager().getTerminalReleaseSnapshot?.(sessionUuid),
    expiredReleaseSnapshot: async (sessionUuid) =>
      await state.getSessionManager().getExpiredReleaseSnapshot?.(sessionUuid),
  });
  const withAdmittedBoundSession: McpForwardPipeline["withAdmittedBoundSession"] = (
    args,
    forward,
    socketSessionId,
  ) =>
    recovery.withAdmittedBoundSession(
      host.isReleasedBoundSession(args, socketSessionId) ? readSessionUuid(args)! : undefined,
      forward,
    );
  const router = new McpForwardRouter({
    ...host,
    withAdmittedBoundSession,
    toolSelectionBaseSession: (sessionUuid) =>
      resolveToolSelectionBaseSessionUuid(sessionUuid, state.getSessionManager()),
    ownedDeviceSessionForMcpSession: (mcpSessionId, deviceId) =>
      state.getDevicePool().resolveOwnedDeviceSessionForMcpSession?.(mcpSessionId, deviceId),
  });
  return { router, recovery, withAdmittedBoundSession };
}
