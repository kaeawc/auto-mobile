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
  releaseReasonFromError,
} from "../types";
import type { AcceptanceSessionRestartScope } from "../daemonRestartAdmission";
import {
  invalidDaemonCommandArgument,
  parseDaemonArgs,
  type DaemonCommandFlagSpec,
} from "./daemonArgs";
import { describeForeignForwardLeaseHolders } from "../forwardLeaseHolders";
import {
  ALLOW_SHARED_NAMESPACE_FLAG,
  assertDaemonNamespaceMatchesState,
} from "../sharedNamespaceGuard";

/**
 * Run daemon management command
 */
export interface RunDaemonCommandOptions {
  clientFactory?: DaemonClientFactory;
  stateProvider?: () => DaemonStateLike;
  startupToolDefaults?: Pick<DaemonOptions, "enabledTools" | "disabledTools">;
  /**
   * Environment the shared-namespace guard reads (#11252). The CLI entry point passes
   * `process.env`; unset skips the guard, so injected-manager tests are unaffected.
   */
  namespaceEnv?: NodeJS.ProcessEnv;
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

/**
 * Owner decision 2026-10-09 (#11096): a one-shot CLI session needs no keeper. Its idle window runs
 * from tool calls, and each `--cli` call re-claims its liveness, so a heartbeat on it is a
 * successful no-op that claims nothing.
 */
function cliIdleNoopMessage(sessionId: string): string {
  return `Session ${sessionId} is a one-shot CLI session: its idle window runs from tool calls, so this heartbeat changed nothing (no keeper is needed).`;
}

/** Record a keeper heartbeat in-process; false when the session is a no-op cli-idle session. */
function recordLocalDaemonHeartbeat(daemonState: DaemonStateLike, sessionId: string): boolean {
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
  if (session.livenessPolicy === "cli-idle") {
    return false;
  }
  sessionManager.recordHeartbeat(sessionId);
  return true;
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
        for (const line of await describeForeignForwardLeaseHolders(
          status.running ? status.pid : undefined,
        )) {
          console.log(line);
        }
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

/** `--json`: print a daemon query's result or refusal as one JSON object (#11252). */
export const DAEMON_JSON_FLAG = "--json";

/**
 * A daemon query or release that failed, keeping the daemon's typed refusal fields (#11252)
 * instead of flattening them into a bare "Failed to ...: message".
 */
export class DaemonCommandRefusal extends ActionableError {
  readonly code?: string;
  readonly nextAction?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly releaseReason?: string;
  readonly detail: string;

  constructor(context: string, error: unknown) {
    const field = (name: string): unknown =>
      error !== null && typeof error === "object" && name in error
        ? (error as Record<string, unknown>)[name]
        : undefined;
    const code = field("code");
    const nextAction = field("nextAction");
    const retryable = field("retryable");
    const retryAfterMs = field("retryAfterMs");
    const releaseReason = releaseReasonFromError(error);
    const detail = errorMessage(error);
    const typedCode =
      typeof code === "string" || typeof code === "number" ? String(code) : undefined;
    const typedNextAction = typeof nextAction === "string" ? nextAction : undefined;
    super(
      `${context}: ${detail}${releaseReason ? ` (released: ${releaseReason})` : ""}` +
        `${typedCode ? ` [${typedCode}]` : ""}${typedNextAction ? ` Next: ${typedNextAction}` : ""}`,
      { cause: error },
    );
    this.detail = detail;
    this.code = typedCode;
    this.nextAction = typedNextAction;
    this.retryable = typeof retryable === "boolean" ? retryable : undefined;
    this.retryAfterMs = typeof retryAfterMs === "number" ? retryAfterMs : undefined;
    this.releaseReason = releaseReason;
  }
}

/** The `--json` object for a failed daemon query; absent refusal fields are omitted. */
function daemonQueryFailureJson(error: unknown): Record<string, unknown> {
  if (!(error instanceof DaemonCommandRefusal)) {
    return { ok: false, error: errorMessage(error) };
  }
  const fields: Record<string, unknown> = {
    code: error.code,
    nextAction: error.nextAction,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    releaseReason: error.releaseReason,
  };
  return {
    ok: false,
    error: error.detail,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  };
}

/** Print a daemon query failure (text on stderr, or one JSON object on stdout) and exit 1. */
function exitWithDaemonQueryFailure(error: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(daemonQueryFailureJson(error)));
  } else if (error instanceof ActionableError) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(`Unexpected error: ${errorMessage(error)}`);
  }
  process.exit(1);
}

/** Split `--json` out of a command's arguments. */
function takeJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  return {
    json: args.includes(DAEMON_JSON_FLAG),
    rest: args.filter((arg) => arg !== DAEMON_JSON_FLAG),
  };
}

async function queryAvailableDevices(args: string[], manager: DaemonManager): Promise<void> {
  const { json } = takeJsonFlag(args);
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
        throw new DaemonCommandRefusal("Failed to query available devices", error);
      }
    }
    return;
  } catch (error) {
    exitWithDaemonQueryFailure(error, json);
  }
}

async function querySessionInfo(rawArgs: string[], manager: DaemonManager): Promise<void> {
  const { json, rest: args } = takeJsonFlag(rawArgs);
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
        throw new DaemonCommandRefusal("Failed to get session info", error);
      }
    }
    return;
  } catch (error) {
    exitWithDaemonQueryFailure(error, json);
  }
}

/**
 * Print `daemon/activeSessions`: every held session with its device, tool activity, owner
 * heartbeat, idle-release deadline, holder kind and in-flight executions (#10671). Always asks
 * the daemon over its socket, so the answer is the daemon's own view.
 */
async function queryActiveSessions(args: string[], manager: DaemonManager): Promise<void> {
  const { json } = takeJsonFlag(args);
  try {
    const client = manager.createClient();
    try {
      await client.connect();
      const result = await client.callDaemonMethod("daemon/activeSessions", {
        includeSessions: true,
      });
      console.log(JSON.stringify(result));
      await client.close();
    } catch (error) {
      throw new DaemonCommandRefusal("Failed to query active sessions", error);
    }
  } catch (error) {
    exitWithDaemonQueryFailure(error, json);
  }
}

async function releaseDaemonSession(rawArgs: string[], manager: DaemonManager): Promise<void> {
  const { json, rest: args } = takeJsonFlag(rawArgs);
  const printReleased = (alreadyReleased: boolean, message: string, device?: string) => {
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          sessionId: args[0],
          alreadyReleased,
          message,
          ...(device !== undefined ? { device } : {}),
        }),
      );
      return;
    }
    console.log(message);
    if (!alreadyReleased && device !== undefined) {
      console.log(`Device ${device} is now available`);
    }
  };
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
      printReleased(false, `Session ${sessionId} released`, deviceId);
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
          .callDaemonMethod("daemon/releaseSession", { sessionId, requireKnown: true })
          .then(async (result: unknown) => {
            await client.close();
            if (!isReleaseResult(result)) {
              throw new ActionableError("Invalid daemon release-session result");
            }
            printReleased(
              result.alreadyReleased,
              result.alreadyReleased ? result.message : `Session ${sessionId} released`,
              result.device,
            );
          });
      } catch (error) {
        throw new DaemonCommandRefusal("Failed to release session", error);
      }
    }
    return;
  } catch (error) {
    exitWithDaemonQueryFailure(error, json);
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
  return `Failed to record session heartbeat: ${errorMessage(error)}${releasedSuffix(error)}`;
}

/** " (released: <reason>)" when the daemon said why a not-found session is gone (#10730). */
function releasedSuffix(error: unknown): string {
  const reason = releaseReasonFromError(error);
  return reason ? ` (released: ${reason})` : "";
}

async function recordDaemonHeartbeat(args: string[], manager: DaemonManager): Promise<void> {
  try {
    const { sessionId, livenessOwnerToken, claimLivenessOwnership } =
      parseDaemonHeartbeatCommandArgs(args);
    const daemonState = manager.getDaemonState();
    if (daemonState.isInitialized()) {
      const recorded = recordLocalDaemonHeartbeat(daemonState, sessionId);
      console.log(
        recorded ? `Session ${sessionId} heartbeat recorded` : cliIdleNoopMessage(sessionId),
      );
      return;
    }
    {
      const client = manager.createClient();
      try {
        await client.connect();
        const result: { livenessUnchanged?: unknown } | undefined = await client.callDaemonMethod(
          "daemon/heartbeat",
          {
            sessionId,
            livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
            livenessOwnerKind: CLI_KEEPER_LIVENESS_OWNER_KIND,
            idleTimeoutMs: getCliSessionIdleTimeoutMs(),
            ...(livenessOwnerToken ? { livenessOwnerToken } : {}),
            ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
          },
        );
        if (result?.livenessUnchanged === true) {
          console.log(cliIdleNoopMessage(sessionId));
          return;
        }
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
  printDaemonUsageError(
    command === undefined ? "Missing daemon command." : `Unknown daemon command: ${command}`,
  );
}

const ACCEPTANCE_SESSION_RESTART_FLAGS = [
  "--session-uuid",
  "--platform",
  "--stable-device-id",
  "--android-sibling-avd-name",
  "--android-duplicate-serial",
  "--ios-same-name-sibling-uuid",
  "--expires-at",
];

/**
 * Daemon commands that take no positional arguments, with the options each accepts. The
 * lifecycle commands are strict (#11252): a stray word or a misspelled option is refused
 * rather than silently stopping or restarting the daemon without it.
 */
const NO_POSITIONAL_DAEMON_COMMANDS: Partial<Record<string, DaemonCommandFlagSpec>> = {
  start: { launchFlags: true },
  stop: { launchFlags: true },
  restart: { launchFlags: true },
  "restart-admitted": { launchFlags: true, valueFlags: ["--maintenance-token"] },
  "restart-acceptance-session": {
    launchFlags: false,
    valueFlags: ACCEPTANCE_SESSION_RESTART_FLAGS,
  },
  status: { launchFlags: true },
  health: { launchFlags: true },
  diagnose: { launchFlags: true },
  "available-devices": { launchFlags: true, booleanFlags: [DAEMON_JSON_FLAG] },
  "active-sessions": { launchFlags: true, booleanFlags: [DAEMON_JSON_FLAG] },
};

/**
 * The usage error for a no-argument daemon command given a stray positional word or an unknown
 * option, or undefined when its arguments are valid. A word right after a value-taking flag is
 * that flag's value, so launch options such as `--port 3001` keep working after the command.
 */
export function daemonCommandArgumentError(command: string, args: string[]): string | undefined {
  const spec = Object.hasOwn(NO_POSITIONAL_DAEMON_COMMANDS, command)
    ? NO_POSITIONAL_DAEMON_COMMANDS[command]
    : undefined;
  if (!spec) {
    return undefined;
  }
  const invalid = invalidDaemonCommandArgument(args, spec);
  if (!invalid) {
    return undefined;
  }
  return invalid.kind === "positional"
    ? `Unexpected argument for daemon ${command}: ${invalid.argument}`
    : `Unknown option for daemon ${command}: ${invalid.argument}`;
}

function printDaemonUsageError(message: string): void {
  try {
    console.error(message);
    console.log("\nAvailable commands:");
    console.log("  start                 Start the daemon");
    console.log("  stop                  Stop the daemon");
    console.log("  status                Check daemon status");
    console.log("  restart               Restart the daemon");
    console.log("  health                Check daemon health");
    console.log("  diagnose              Run full diagnostics");
    console.log("  available-devices     Query device pool status");
    console.log("  active-sessions       List held sessions and why each holds its device");
    console.log("  session-info <id>     Get information about a session");
    console.log("  release-session <id>  Release a session and free its device");
    console.log(
      "  (available-devices, active-sessions, session-info and release-session accept --json)",
    );
    console.log(
      "  release-liveness-ownership <id> --liveness-owner-token <token>  Hand off liveness; keep the device",
    );
    console.log(
      "  heartbeat <id>        Heartbeat a session (one-shot CLI: no-op; proxy-owned: refused)",
    );
    console.log("\nOptions:");
    console.log(
      `  ${ALLOW_SHARED_NAMESPACE_FLAG}  Let start/stop/restart/release act on the shared daemon while AUTOMOBILE_DATA_DIR or DB dirs are set without AUTOMOBILE_AUX_SOCKET_DIR`,
    );
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

/**
 * Commands that stop, replace or release on a daemon. With a private state env but the shared
 * namespace they would act on the resident daemon (#11252), so they pass the namespace guard.
 */
const NAMESPACE_GUARDED_DAEMON_COMMANDS = new Set([
  "start",
  "stop",
  "restart",
  "restart-admitted",
  "restart-acceptance-session",
  "release-session",
  "release-liveness-ownership",
]);

function refuseSharedNamespaceAction(
  command: string,
  env: NodeJS.ProcessEnv,
  allowShared: boolean,
): boolean {
  if (!NAMESPACE_GUARDED_DAEMON_COMMANDS.has(command)) {
    return false;
  }
  try {
    assertDaemonNamespaceMatchesState(`run daemon ${command}`, env, allowShared);
    return false;
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    process.exit(1);
    return true;
  }
}

export async function runDaemonCommand(
  command: string,
  rawArgs: string[],
  options: RunDaemonCommandOptions,
  DaemonManager: new (
    clientFactory?: DaemonClientFactory,
    stateProvider?: () => DaemonStateLike,
  ) => DaemonManager,
): Promise<void> {
  const allowSharedNamespace = rawArgs.includes(ALLOW_SHARED_NAMESPACE_FLAG);
  const args = rawArgs.filter((arg) => arg !== ALLOW_SHARED_NAMESPACE_FLAG);
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
    "available-devices": () => queryAvailableDevices(args, manager),
    "active-sessions": () => queryActiveSessions(args, manager),
    "session-info": () => querySessionInfo(args, manager),
    "release-session": () => releaseDaemonSession(args, manager),
    heartbeat: () => recordDaemonHeartbeat(args, manager),
    "release-liveness-ownership": () => releaseDaemonLivenessOwnership(args, manager),
  };
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
  if (!handler) {
    return printUnknownDaemonCommand(command);
  }
  const argumentError = daemonCommandArgumentError(command, args);
  if (argumentError !== undefined) {
    return printDaemonUsageError(argumentError);
  }
  if (
    options.namespaceEnv &&
    refuseSharedNamespaceAction(command, options.namespaceEnv, allowSharedNamespace)
  ) {
    return;
  }
  return handler();
}
