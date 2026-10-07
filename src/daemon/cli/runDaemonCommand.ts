import { isSessionReleasing } from "../sessionReleaseState";
import { handleDaemonRequest, refuseCliKeeperOnProxySession } from "../daemonRequestHandlers";
import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError } from "../../models";
import { resolveDaemonInstallSpecifier } from "../../constants/release";
import {
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD,
  CLI_SESSION_LIVENESS_POLICY,
  getCliSessionIdleTimeoutMs,
} from "../constants";
import {
  getDaemonHealthReport,
  formatHealthReport,
  runSocketDiagnostics,
  formatSocketDiagnostics,
} from "../debugTools";
import {
  getCurrentBuildIdentity,
  buildIdentityFromStatus,
  buildIdentitiesMatch,
  describeBuildIdentity,
  type BuildIdentity,
} from "../buildIdentity";
import type { DaemonClientFactory } from "../client";
import type { DaemonStateLike } from "../daemonState";
import type { DaemonManager } from "../manager";
import type { DaemonOptions, DaemonStatus } from "../types";
import {
  DAEMON_LIVENESS_OWNER_IS_PROXY_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
} from "../types";
import type { AcceptanceSessionRestartScope } from "../daemonRestartAdmission";
import { parseDaemonArgs } from "./daemonArgs";

/**
 * Run daemon management command
 */
export interface RunDaemonCommandOptions {
  clientFactory?: DaemonClientFactory;
  stateProvider?: () => DaemonStateLike;
  startupToolDefaults?: Pick<DaemonOptions, "enabledTools" | "disabledTools">;
}

export function daemonCommandOptions(
  args: string[],
  options: RunDaemonCommandOptions,
): DaemonOptions {
  const parsed = parseDaemonArgs(args);
  if (!options.startupToolDefaults) {
    return parsed;
  }
  return {
    ...parsed,
    ...(options.startupToolDefaults.enabledTools !== undefined
      ? { enabledTools: [...options.startupToolDefaults.enabledTools] }
      : {}),
    ...(options.startupToolDefaults.disabledTools !== undefined
      ? { disabledTools: [...options.startupToolDefaults.disabledTools] }
      : {}),
  };
}

export interface DaemonHeartbeatCommandArgs {
  sessionId: string;
  livenessOwnerToken?: string;
  claimLivenessOwnership: boolean;
}

/**
 * Parse the ownership options used by first-party recurring heartbeat keepers.
 *
 * A bare `--daemon heartbeat <session>` intentionally stays tokenless for
 * legacy external callers. A keeper that spans several one-shot CLI processes
 * supplies one stable token, claiming it once and proving it on later ticks.
 */
export function parseDaemonHeartbeatCommandArgs(args: string[]): DaemonHeartbeatCommandArgs {
  const sessionId = args[0];
  if (!sessionId) {
    throw new ActionableError("heartbeat requires a session ID argument");
  }

  let livenessOwnerToken: string | undefined;
  let claimLivenessOwnership = false;
  for (let index = 1; index < args.length; index++) {
    switch (args[index]) {
      case "--liveness-owner-token": {
        const ownerToken = args[index + 1];
        if (!ownerToken || ownerToken.startsWith("--")) {
          throw new ActionableError("--liveness-owner-token requires a non-empty value");
        }
        livenessOwnerToken = ownerToken;
        index++;
        break;
      }
      case "--claim-liveness-ownership":
        claimLivenessOwnership = true;
        break;
      default:
        throw new ActionableError(`Unknown heartbeat option: ${args[index]}`);
    }
  }

  if (claimLivenessOwnership && !livenessOwnerToken) {
    throw new ActionableError("--claim-liveness-ownership requires --liveness-owner-token");
  }

  return { sessionId, livenessOwnerToken, claimLivenessOwnership };
}

export function parseRestartAdmittedMaintenanceToken(args: string[]): string {
  const tokenIndex = args.indexOf("--maintenance-token");
  const token = tokenIndex === -1 ? undefined : args[tokenIndex + 1];
  if (!token || token.startsWith("--")) {
    throw new ActionableError("--maintenance-token requires a non-empty value");
  }
  return token;
}

export function parseAcceptanceSessionRestartScope(args: string[]): AcceptanceSessionRestartScope {
  const read = (flag: string): string => {
    const index = args.indexOf(flag);
    const value = index === -1 ? undefined : args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ActionableError(`${flag} requires a non-empty value`);
    }
    return value;
  };
  const platform = read("--platform");
  if (platform !== "android" && platform !== "ios") {
    throw new ActionableError("--platform must be android or ios");
  }
  const expiresAt = Number(read("--expires-at"));
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new ActionableError("--expires-at must be a positive finite timestamp");
  }
  return {
    sessionUuid: read("--session-uuid"),
    platform,
    stableDeviceId: read("--stable-device-id"),
    controls: {
      androidSiblingAvdName: read("--android-sibling-avd-name"),
      androidDuplicateSerial: read("--android-duplicate-serial"),
      iosSameNameSiblingUdid: read("--ios-same-name-sibling-uuid"),
    },
    expiresAt,
  };
}

/**
 * Build the `--daemon status` lines that surface the running daemon's build
 * identity (`buildId` + `entryScript`) and flag wrong-build skew against this
 * client. Pure so it is unit-testable without a live daemon. See #2736.
 *
 * @param status the running daemon's status (must be `running`)
 * @param client this client's build identity
 */
export function daemonBuildIdentityStatusLines(
  status: DaemonStatus,
  client: BuildIdentity,
): string[] {
  const daemon = buildIdentityFromStatus(status);
  const lines = [
    `  Build ID: ${daemon.buildId || "unknown"}`,
    `  Entry Script: ${daemon.entryScript || "unknown"}`,
  ];

  if (!buildIdentitiesMatch(client, daemon)) {
    lines.push(
      "\n⚠️  WARNING: the running daemon is a different build than this checkout:",
      `  daemon build=${describeBuildIdentity(daemon)}`,
      `  client build=${describeBuildIdentity(client)}`,
      "\nRestart the daemon from this checkout (run `--daemon restart` with this same CLI) to align them.",
    );
  }

  return lines;
}

const formatPoolStats = (
  stats?: { idle: number; assigned: number; error: number; total: number },
  recoveryPolicy?: { onLoss: boolean; maxAttempts: number },
  devices?: Array<{ deviceId: string; platform: string; recoveryEligibility?: unknown }>,
) =>
  JSON.stringify({
    availableDevices: stats?.idle ?? 0,
    totalDevices: stats?.total ?? 0,
    assignedDevices: stats?.assigned ?? 0,
    errorDevices: stats?.error ?? 0,
    ...(recoveryPolicy ? { recoveryPolicy } : {}),
    ...(devices ? { devices } : {}),
  });

function printAvailableDevicesContent(content: string | undefined): void {
  if (!content) {
    console.log(formatPoolStats());
  } else {
    const data = JSON.parse(content);
    console.log(
      formatPoolStats(
        data?.poolStatus,
        data?.poolStatus?.recoveryPolicy,
        data?.devices?.map(
          (device: {
            platform: string;
            runtime?: { deviceId?: string | null };
            recoveryEligibility?: unknown;
          }) => ({
            deviceId: device.runtime?.deviceId ?? "unknown",
            platform: device.platform,
            recoveryEligibility: device.recoveryEligibility,
          }),
        ),
      ),
    );
  }
}

function printDaemonStatus(status: DaemonStatus, manager: DaemonManager): void {
  if (status.recovery) {
    console.log(
      `  Identity recovery: ${status.recovery.state}${status.recovery.reason ? ` (${status.recovery.reason})` : ""}`,
    );
  }
  if (status.running) {
    console.log("Daemon is running");
    console.log(`  PID: ${status.pid}`);
    console.log(`  Port: ${status.port}`);
    console.log(`  Socket: ${status.socketPath}`);
    console.log(`  Database: ${status.dbPath || "unknown"}`);
    console.log(`  Version: ${status.version || "unknown"}`);
    console.log(
      `  Started: ${status.startedAt ? new Date(status.startedAt).toISOString() : "unknown"}`,
    );
    for (const line of daemonBuildIdentityStatusLines(status, getCurrentBuildIdentity())) {
      console.log(line);
    }

    // Check for other daemon processes (exclude current daemon)
    const otherDaemons = manager.findOtherDaemonProcesses(status.pid);
    if (otherDaemons.length > 0) {
      console.log(
        `\n⚠️  WARNING: Found ${otherDaemons.length} other daemon process(es) from other worktrees:`,
      );
      for (const pid of otherDaemons) {
        console.log(`  - PID ${pid}`);
      }
      console.log(
        `\nThese can cause device pool conflicts. Run 'bunx ${resolveDaemonInstallSpecifier()} --daemon restart' to stop them.`,
      );
    }
  } else {
    console.log("Daemon is not running");
  }
}

function requireDaemonSession(
  sessionManager: ReturnType<DaemonStateLike["getSessionManager"]>,
  sessionId: string,
) {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new ActionableError(`Session not found: ${sessionId}`);
  }
  return session;
}

function recordLocalDaemonHeartbeat(daemonState: DaemonStateLike, sessionId: string): void {
  const sessionManager = daemonState.getSessionManager();
  const session =
    sessionManager.getSession(sessionId) ?? sessionManager.getReleasingSession(sessionId);
  if (!session || isSessionReleasing(sessionManager, sessionId, session)) {
    throw new ActionableError(`Session not found: ${sessionId}`);
  }
  const refusal = refuseCliKeeperOnProxySession(CLI_KEEPER_LIVENESS_OWNER_KIND, session);
  if (refusal) {
    throw new ActionableError(
      heartbeatFailureMessage(
        sessionId,
        Object.assign(new Error(refusal.error), { code: refusal.code }),
      ),
    );
  }
  sessionManager.recordHeartbeat(sessionId);
}

async function runDaemonLifecycleCommand(
  command: string,
  args: string[],
  options: RunDaemonCommandOptions,
  manager: DaemonManager,
): Promise<void> {
  try {
    switch (command) {
      case "start": {
        await manager.start(daemonCommandOptions(args, options));
        break;
      }

      case "stop":
        await manager.stop();
        break;

      case "restart": {
        await manager.restart(daemonCommandOptions(args, options));
        break;
      }

      case "restart-admitted": {
        await manager.restartAdmitted(
          daemonCommandOptions(args, options),
          parseRestartAdmittedMaintenanceToken(args),
        );
        break;
      }

      case "restart-acceptance-session": {
        await manager.restartAcceptanceSession(parseAcceptanceSessionRestartScope(args));
        break;
      }
    }
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}

async function runDaemonDiagnosticsCommand(command: string, manager: DaemonManager): Promise<void> {
  try {
    switch (command) {
      case "status": {
        const status = await manager.status();
        printDaemonStatus(status, manager);
        break;
      }

      case "health": {
        const report = await getDaemonHealthReport();
        console.log(formatHealthReport(report));

        // Exit with error code if daemon is not healthy
        if (!report.daemonRunning || !report.socketConnectable) {
          process.exit(1);
        }
        break;
      }

      case "diagnose": {
        console.log("Running daemon diagnostics...\n");

        // Run health check
        const healthReport = await getDaemonHealthReport();
        console.log(formatHealthReport(healthReport));

        // Run socket diagnostics
        const socketDiag = await runSocketDiagnostics();
        console.log(formatSocketDiagnostics(socketDiag));

        // Exit with error code if issues found
        if (healthReport.recommendations.length > 0 || socketDiag.issues.length > 0) {
          process.exit(1);
        }
        break;
      }
    }
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}

async function queryAvailableDevices(manager: DaemonManager): Promise<void> {
  try {
    // Check if running in daemon process
    const daemonState = manager.getDaemonState();
    if (daemonState.isInitialized()) {
      // Running inside daemon process
      const pool = daemonState.getDevicePool();
      console.log(
        formatPoolStats(
          pool.getStats(),
          pool.getRecoveryPolicy(),
          pool.getAllDevices().map((device) => ({
            deviceId: device.id,
            platform: device.platform,
            recoveryEligibility: pool.getRecoveryEligibility(device.id),
          })),
        ),
      );
      return;
    }
    {
      // Running from CLI - query daemon via socket
      const client = manager.createClient();
      try {
        await client.connect();
        const result = await client.readResource("automobile:devices/booted");
        const content = result?.contents?.[0]?.text;
        printAvailableDevicesContent(content);
        await client.close();
      } catch (error) {
        throw new ActionableError(`Failed to query available devices: ${errorMessage(error)}`);
      }
    }
    return;
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}

async function querySessionInfo(args: string[], manager: DaemonManager): Promise<void> {
  try {
    if (args.length === 0) {
      throw new ActionableError("session-info requires a session ID argument");
    }
    const sessionId = args[0];

    // Check if running in daemon process
    const daemonState = manager.getDaemonState();
    if (daemonState.isInitialized()) {
      // Running inside daemon process
      const sessionManager = daemonState.getSessionManager();
      const session = requireDaemonSession(sessionManager, sessionId);
      console.log(
        JSON.stringify({
          sessionId: session.sessionId,
          assignedDevice: session.assignedDevice,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          expiresAt: session.expiresAt,
          cacheSize: JSON.stringify(session.cacheData).length,
        }),
      );
      return;
    }
    {
      // Running from CLI - query daemon via socket
      const client = manager.createClient();
      try {
        await client.connect();
        const result = await client.callDaemonMethod("daemon/sessionInfo", { sessionId });
        console.log(JSON.stringify(result));
        await client.close();
      } catch (error) {
        throw new ActionableError(`Failed to get session info: ${errorMessage(error)}`);
      }
    }
    return;
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}

async function releaseDaemonSession(args: string[], manager: DaemonManager): Promise<void> {
  try {
    if (args.length === 0) {
      throw new ActionableError("release-session requires a session ID argument");
    }
    const sessionId = args[0];

    // Check if running in daemon process
    const daemonState = manager.getDaemonState();
    if (daemonState.isInitialized()) {
      // Running inside daemon process
      const sessionManager = daemonState.getSessionManager();
      const pool = daemonState.getDevicePool();
      const session = requireDaemonSession(sessionManager, sessionId);
      const deviceId = session.assignedDevice;
      await sessionManager.releaseSession(sessionId);
      await pool.releaseDevice(deviceId, sessionId);
      console.log(`Session ${sessionId} released`);
      console.log(`Device ${deviceId} is now available`);
      return;
    }
    {
      // Running from CLI - query daemon via socket
      const client = manager.createClient();
      const isReleaseResult = (
        result: unknown,
      ): result is {
        message: string;
        alreadyReleased: boolean;
        device?: string;
      } =>
        result !== null &&
        typeof result === "object" &&
        "message" in result &&
        typeof result.message === "string" &&
        "alreadyReleased" in result &&
        typeof result.alreadyReleased === "boolean" &&
        (!("device" in result) || result.device === undefined || typeof result.device === "string");
      try {
        await client.connect();
        await client
          .callDaemonMethod("daemon/releaseSession", { sessionId })
          .then(async (result: unknown) => {
            await client.close();
            if (!isReleaseResult(result)) {
              throw new ActionableError("Invalid daemon release-session result");
            }
            console.log(result.alreadyReleased ? result.message : `Session ${sessionId} released`);
            if (!result.alreadyReleased && result.device !== undefined) {
              console.log(`Device ${result.device} is now available`);
            }
          });
      } catch (error) {
        throw new ActionableError(`Failed to release session: ${errorMessage(error)}`);
      }
    }
    return;
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}

function heartbeatFailureMessage(sessionId: string, error: unknown): string {
  const code =
    error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE) {
    return `The token no longer owns session ${sessionId}'s liveness. Re-claim with a fresh --liveness-owner-token and --claim-liveness-ownership, or stop the keeper.`;
  }
  if (code === DAEMON_LIVENESS_OWNER_UNOWNED_CODE) {
    return `Session ${sessionId}'s liveness is unowned. Explicitly claim with --claim-liveness-ownership before sending keeper ticks, or stop the keeper. [${DAEMON_LIVENESS_OWNER_UNOWNED_CODE}]`;
  }
  if (code === DAEMON_LIVENESS_OWNER_IS_PROXY_CODE) {
    // The daemon's message names the proxy-owned session; keep the code visible for scripts.
    return `${errorMessage(error)} [${DAEMON_LIVENESS_OWNER_IS_PROXY_CODE}] Stop this keeper; heartbeat only works for one-shot CLI sessions.`;
  }
  return `Failed to record session heartbeat: ${errorMessage(error)}`;
}

async function recordDaemonHeartbeat(args: string[], manager: DaemonManager): Promise<void> {
  try {
    const { sessionId, livenessOwnerToken, claimLivenessOwnership } =
      parseDaemonHeartbeatCommandArgs(args);
    const daemonState = manager.getDaemonState();
    if (daemonState.isInitialized()) {
      recordLocalDaemonHeartbeat(daemonState, sessionId);
      console.log(`Session ${sessionId} heartbeat recorded`);
      return;
    }
    {
      const client = manager.createClient();
      try {
        await client.connect();
        await client.callDaemonMethod("daemon/heartbeat", {
          sessionId,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerKind: CLI_KEEPER_LIVENESS_OWNER_KIND,
          idleTimeoutMs: getCliSessionIdleTimeoutMs(),
          ...(livenessOwnerToken ? { livenessOwnerToken } : {}),
          ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
        });
      } catch (error) {
        throw new ActionableError(heartbeatFailureMessage(sessionId, error));
      } finally {
        await client.close();
      }
    }
    console.log(`Session ${sessionId} heartbeat recorded`);
    return;
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}

export function parseDaemonReleaseLivenessCommandArgs(args: string[]): {
  sessionId: string;
  livenessOwnerToken: string;
} {
  if (
    args.length !== 3 ||
    !args[0] ||
    args[1] !== "--liveness-owner-token" ||
    !args[2]?.trim() ||
    args[2].startsWith("--")
  ) {
    throw new ActionableError(
      "Usage: release-liveness-ownership <session> --liveness-owner-token <token>",
    );
  }
  return { sessionId: args[0], livenessOwnerToken: args[2] };
}

async function releaseDaemonLivenessOwnership(
  args: string[],
  manager: DaemonManager,
): Promise<void> {
  try {
    const params = parseDaemonReleaseLivenessCommandArgs(args);
    const state = manager.getDaemonState();
    if (state.isInitialized()) {
      const response = await handleDaemonRequest(
        {
          id: "release-liveness-ownership",
          type: "daemon_request",
          method: DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD,
          params,
        },
        state,
      );
      if (!response.success) {
        throw new ActionableError(`${response.error} [${response.code}]`);
      }
      console.log(JSON.stringify(response.result));
      return;
    }
    const client = manager.createClient();
    try {
      await client.connect();
      console.log(
        JSON.stringify(
          await client.callDaemonMethod(DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD, params),
        ),
      );
    } finally {
      await client.close();
    }
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    console.error(
      `Failed to release liveness ownership: ${errorMessage(error)}${typeof code === "string" ? ` [${code}]` : ""}`,
    );
    process.exit(1);
  }
}

export function printUnknownDaemonCommand(command: string | undefined): void {
  try {
    console.error(
      command === undefined ? "Missing daemon command." : `Unknown daemon command: ${command}`,
    );
    console.log("\nAvailable commands:");
    console.log("  start                 Start the daemon");
    console.log("  stop                  Stop the daemon");
    console.log("  status                Check daemon status");
    console.log("  restart               Restart the daemon");
    console.log("  health                Check daemon health");
    console.log("  diagnose              Run full diagnostics");
    console.log("  available-devices     Query device pool status");
    console.log("  session-info <id>     Get information about a session");
    console.log("  release-session <id>  Release a session and free its device");
    console.log(
      "  release-liveness-ownership <id> --liveness-owner-token <token>  Hand off liveness; keep the device",
    );
    console.log("  heartbeat <id>        Heartbeat a one-shot CLI session (proxy-owned: refused)");
    process.exit(1);
  } catch (error) {
    if (error instanceof ActionableError) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}

export async function runDaemonCommand(
  command: string,
  args: string[],
  options: RunDaemonCommandOptions,
  DaemonManager: new (
    clientFactory?: DaemonClientFactory,
    stateProvider?: () => DaemonStateLike,
  ) => DaemonManager,
): Promise<void> {
  const manager = new DaemonManager(options.clientFactory, options.stateProvider);

  const handlers: Partial<Record<string, () => Promise<void> | void>> = {
    start: () => runDaemonLifecycleCommand(command, args, options, manager),
    stop: () => runDaemonLifecycleCommand(command, args, options, manager),
    restart: () => runDaemonLifecycleCommand(command, args, options, manager),
    "restart-admitted": () => runDaemonLifecycleCommand(command, args, options, manager),
    "restart-acceptance-session": () => runDaemonLifecycleCommand(command, args, options, manager),
    status: () => runDaemonDiagnosticsCommand(command, manager),
    health: () => runDaemonDiagnosticsCommand(command, manager),
    diagnose: () => runDaemonDiagnosticsCommand(command, manager),
    "available-devices": () => queryAvailableDevices(manager),
    "session-info": () => querySessionInfo(args, manager),
    "release-session": () => releaseDaemonSession(args, manager),
    heartbeat: () => recordDaemonHeartbeat(args, manager),
    "release-liveness-ownership": () => releaseDaemonLivenessOwnership(args, manager),
  };
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
  if (!handler) {
    return printUnknownDaemonCommand(command);
  }
  return handler();
}
