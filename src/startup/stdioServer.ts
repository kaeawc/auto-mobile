import { DeviceReadiness } from "../daemon/readiness/DeviceReadiness";
import {
  installStdinShutdownHandlers,
  installStdoutShutdownHandler,
  requestProcessShutdown,
} from "../processLifecycle";
import type { SessionBrokerResult } from "../devices/sessionBrokerResult";
import type { SessionConfig } from "../devices/sessionConfig";
import type { DaemonOptions } from "../daemon/types";
import { startupBenchmark } from "../utils/startupBenchmark";
import type { ServerModules } from "./serverModules";
import type { ParsedArgs, StdioRuntimeState } from "./startupContext";

/** Launch facts the stdio server needs beyond the parsed command line. */
export interface StdioLaunchContext {
  launchParentPid: number;
  ownerGenerationToken: string | undefined;
  daemonStartupOptions: DaemonOptions;
}

type StdioTransport = InstanceType<ServerModules["OutputGatedTransport"]>;
type ConnectableServer = ReturnType<ServerModules["createMcpServer"]>;

/**
 * Runs the MCP server over stdio. In proxy mode (default) it proxies requests to the daemon, which
 * manages device state and tool execution; in no-proxy mode (--no-proxy flag) it executes tools
 * directly.
 */
export async function runStdioServer(
  args: ParsedArgs,
  modules: ServerModules,
  state: StdioRuntimeState,
  launch: StdioLaunchContext,
): Promise<void> {
  const { logger } = modules;
  const useProxyMode = !args.noProxy;
  const deviceReadiness = useProxyMode ? undefined : DeviceReadiness.createInstance();
  state.directModeActive = !useProxyMode;

  if (useProxyMode) {
    logger.info("Starting MCP server in proxy mode (connecting to daemon)");
  } else {
    logger.info("Starting MCP server in direct mode (--no-proxy flag)");
    await startDirectModeServices(modules, deviceReadiness!);
  }

  // Run as MCP server with STDIO transport.
  const stdioTransport = new modules.OutputGatedTransport(modules.createStdioServerTransport());
  const connecting = await installStdioTransportShutdown(stdioTransport);

  // A broker binding proxy reads stdin from the start, so EOF during its acquisition shuts it
  // down (aborting the acquisition), while initialize waits for the acquisition's result.
  const earlyTransport =
    useProxyMode && args.sessionConfig
      ? new (await import("../server/earlyStartTransport")).EarlyStartTransport(stdioTransport)
      : undefined;
  await earlyTransport?.startEarly();
  const { server, proxyToClaimInitialSession } = await createStdioMcpServer(
    args,
    modules,
    state,
    launch,
    useProxyMode,
    deviceReadiness,
  );
  try {
    logger.info("Connecting MCP server to stdio transport");
    startupBenchmark.startPhase("serverListening");
    connecting.value = true;
    await server.connect(earlyTransport ?? stdioTransport);
    startupBenchmark.endPhase("serverListening");
    logger.info("MCP server connected to stdio transport");
    // `--initial-session-uuid` adopts its session now, not on the first tool call.
    void proxyToClaimInitialSession?.claimInitialSession();
    logger.info(
      `AutoMobile MCP server running on stdio (${useProxyMode ? "proxy" : "direct"} mode)`,
    );
    startupBenchmark.emit("mcp-server", {
      transport: "stdio",
      mode: useProxyMode ? "proxy" : "direct",
    });
  } catch (error) {
    logger.error("MCP server connect failed:", error);
    throw error;
  }
}

/** Start auxiliary services only in direct mode. */
export async function startDirectModeServices(
  modules: Pick<
    ServerModules,
    | "startVideoRecordingSocketServer"
    | "startDeviceGestureRecordingSocketServer"
    | "startDeviceSnapshotSocketServer"
    | "startAppearanceSocketServer"
    | "createDirectModeAppearanceDeviceSource"
    | "startWebRtcStreamSocketServer"
  >,
  deviceReadiness: DeviceReadiness,
): Promise<void> {
  await modules.startVideoRecordingSocketServer();
  await modules.startDeviceGestureRecordingSocketServer(deviceReadiness);
  await modules.startDeviceSnapshotSocketServer();
  // No pool or session on a sessionless request: it re-themes the devices this process readied.
  await modules.startAppearanceSocketServer(
    modules.createDirectModeAppearanceDeviceSource(() => {
      const pin = deviceReadiness.getExplicitDevicePin();
      return pin ? [pin] : [];
    }),
  );
  await modules.startWebRtcStreamSocketServer();
}

/**
 * Detect when the MCP client disconnects (stdin closes / stdout writes fail). This uses the shared
 * lifecycle handler so resources close before exit. The returned flag turns true once the server
 * is connecting, after which an EOF still answers what was received.
 */
async function installStdioTransportShutdown(
  stdioTransport: StdioTransport,
): Promise<{ value: boolean }> {
  const { MAX_CALLER_MCP_REQUEST_TIMEOUT_MS } = await import("../daemon/mcpRequestTimeout");
  const connecting = { value: false };
  installStdinShutdownHandlers(
    process.stdin,
    () =>
      connecting.value
        ? stdioTransport.answerReceivedThenStop("stdin closed")
        : stdioTransport.stopSending("stdin closed"),
    MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
  );
  installStdoutShutdownHandler(process.stdout, () =>
    stdioTransport.stopSending("stdout write failed"),
  );
  return connecting;
}

async function createStdioMcpServer(
  args: ParsedArgs,
  modules: ServerModules,
  state: StdioRuntimeState,
  launch: StdioLaunchContext,
  useProxyMode: boolean,
  deviceReadiness?: DeviceReadiness,
): Promise<{
  server: ConnectableServer;
  proxyToClaimInitialSession: { claimInitialSession(): Promise<void> } | undefined;
}> {
  try {
    if (!useProxyMode) {
      return {
        server: modules.createMcpServer({ debug: args.debug, deviceReadiness }),
        proxyToClaimInitialSession: undefined,
      };
    }
    const { getDefaultSessionHeartbeatTimeoutMs } = await import("../daemon/sessionManager");
    const proxy = modules.createDaemonMcpProxy({
      autoStartDaemon: !args.noDaemon,
      lifecycleNamespaceEnv: process.env,
      daemonOptions: launch.daemonStartupOptions,
      initialSessionUuid: args.initialSessionUuid,
      livenessOwnerToken: args.livenessOwnerToken,
      heartbeatTimeoutMs: getDefaultSessionHeartbeatTimeoutMs(),
    });
    // Published first, so shutdown (stdin EOF, SIGTERM) closes it and aborts an acquisition.
    state.stdioProxy = proxy;
    const session = args.sessionConfig
      ? await acquireBrokerSessionBeforeServing(
          proxy,
          args.sessionConfig,
          launch.launchParentPid,
          launch.ownerGenerationToken,
          modules,
        )
      : undefined;
    const result = modules.createProxyMcpServer({
      proxy,
      ...(session ? { session } : {}),
    });
    return { server: result.server, proxyToClaimInitialSession: result.proxy };
  } catch (error) {
    modules.logger.error("Failed to create MCP server:", error);
    throw error;
  }
}

/** Prepare one durable broker request while stdin and owner-loss cancellation are already armed. */
async function acquireBrokerSessionBeforeServing(
  proxy: {
    acquireBrokerSession(config: SessionConfig): Promise<SessionBrokerResult>;
    setExecutionOwnerLossProbe(probe: () => boolean): void;
  },
  config: SessionConfig,
  launchParentPid: number,
  ownerGenerationToken: string | undefined,
  modules: ServerModules,
): Promise<SessionBrokerResult> {
  const ownerWatch = await startExecutionOwnerWatch(
    launchParentPid,
    config.executionOwnerPid,
    ownerGenerationToken,
  );
  // Stdin EOF can start the close before the watch's next poll; ask the owner directly (#12986).
  proxy.setExecutionOwnerLossProbe(() => ownerWatch.check() !== undefined);
  const result = await proxy.acquireBrokerSession(config);
  modules.logger.info(
    `[SessionBroker] Acquisition ${result.outcome}` +
      (result.failure ? ` (${result.failure.code})` : ""),
  );
  return result;
}

/** Watch the broker binding execution's owner (by default the launching parent) (#11176). */
async function startExecutionOwnerWatch(
  launchParentPid: number,
  ownerPid?: number,
  ownerGenerationToken?: string,
): Promise<{ check(): unknown }> {
  const [
    { ExecutionOwnerWatch },
    { isProcessRunning },
    { defaultTimer },
    { defaultLockOwnerGenerationProbe },
    { processGenerationReadIsCheap },
  ] = await Promise.all([
    import("../daemon/executionOwnerWatch"),
    import("../utils/processLiveness"),
    import("../utils/SystemTimer"),
    import("../daemon/lockOwnerGeneration"),
    import("../daemon/processGeneration"),
  ]);
  const watch = new ExecutionOwnerWatch(
    {
      launchParentPid,
      ownerPid,
      ownerGenerationToken,
      generationCheckEvery: processGenerationReadIsCheap() ? 1 : undefined,
      onOwnerLost: () => requestProcessShutdown("execution-owner-lost"),
    },
    { isProcessRunning: (pid) => isProcessRunning(pid), currentParentPid: () => process.ppid },
    defaultTimer,
    defaultLockOwnerGenerationProbe,
  );
  watch.start();
  return watch;
}
