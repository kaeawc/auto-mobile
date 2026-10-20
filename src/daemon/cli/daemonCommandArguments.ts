import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError } from "../../models";
import type { AcceptanceSessionRestartScope } from "../daemonRestartAdmission";
import { invalidDaemonCommandArgument, type DaemonCommandFlagSpec } from "./daemonArgs";
import {
  findValueOperand,
  parseBooleanFlagValue,
  readValueOperand,
  splitFlagToken,
} from "../../utils/flagTokens";
import { ALLOW_SHARED_NAMESPACE_FLAG } from "../sharedNamespaceGuard";
import {
  sessionBrokerCommandArgsAreValid,
  sessionBrokerCommandUsage,
  type SessionBrokerCliCommand,
} from "./sessionBrokerCommands";
import {
  DAEMON_CAPABILITIES_COMMAND_USAGE,
  daemonCapabilitiesCommandArgsAreValid,
} from "./daemonCapabilitiesCommand";

/** `--json`: print a daemon query's result or refusal as one JSON object (#11252). */
export const DAEMON_JSON_FLAG = "--json";

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
    const { flag, inlineValue } = splitFlagToken(args[index]);
    switch (flag) {
      case "--liveness-owner-token": {
        const operand = readValueOperand(args, index);
        if (!operand.value) {
          throw new ActionableError("--liveness-owner-token requires a non-empty value");
        }
        livenessOwnerToken = operand.value;
        index = operand.last;
        break;
      }
      case "--claim-liveness-ownership": {
        const claim = parseBooleanFlagValue(inlineValue);
        if (claim === undefined) {
          throw new ActionableError(
            `Invalid value for --claim-liveness-ownership: ${inlineValue}; expected true or false`,
          );
        }
        claimLivenessOwnership = claim;
        break;
      }
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
  const token = findValueOperand(args, ["--maintenance-token"])?.value;
  if (!token) {
    throw new ActionableError("--maintenance-token requires a non-empty value");
  }
  return token;
}

export function parseAcceptanceSessionRestartScope(args: string[]): AcceptanceSessionRestartScope {
  const read = (flag: string): string => {
    const value = findValueOperand(args, [flag])?.value;
    if (!value) {
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
 * Daemon commands with the options and positional words each accepts (none by default). The
 * commands are strict (#11252, #11612): a stray word or a misspelled option is refused rather
 * than silently stopping or restarting the daemon, or releasing a session, without it.
 */
const STRICT_DAEMON_COMMANDS: Partial<Record<string, DaemonCommandFlagSpec>> = {
  start: { launchFlags: true },
  stop: { launchFlags: true },
  restart: { launchFlags: true },
  "restart-admitted": { launchFlags: true, valueFlags: ["--maintenance-token"] },
  "restart-acceptance-session": {
    launchFlags: false,
    valueFlags: ACCEPTANCE_SESSION_RESTART_FLAGS,
  },
  status: { launchFlags: true, booleanFlags: [DAEMON_JSON_FLAG] },
  capabilities: { launchFlags: false, booleanFlags: [DAEMON_JSON_FLAG] },
  health: { launchFlags: true },
  diagnose: { launchFlags: true },
  "available-devices": { launchFlags: true, booleanFlags: [DAEMON_JSON_FLAG] },
  "active-sessions": { launchFlags: true, booleanFlags: [DAEMON_JSON_FLAG] },
  // One session id each, optionally with --json: `release-session a b` would free only `a`
  // and `session-info a --jsno` would drop the typo'd flag (#11612).
  "session-info": { launchFlags: false, booleanFlags: [DAEMON_JSON_FLAG], positionals: 1 },
  "release-session": { launchFlags: false, booleanFlags: [DAEMON_JSON_FLAG], positionals: 1 },
  "session-request-status": {
    launchFlags: false,
    valueFlags: ["--liveness-owner-token"],
    booleanFlags: [DAEMON_JSON_FLAG],
    positionals: 1,
  },
  "abandon-session-request": {
    launchFlags: false,
    valueFlags: ["--liveness-owner-token"],
    booleanFlags: [DAEMON_JSON_FLAG],
    positionals: 1,
  },
  "release-broker-session": {
    launchFlags: false,
    valueFlags: ["--liveness-owner-token"],
    booleanFlags: [DAEMON_JSON_FLAG],
    positionals: 1,
  },
};

function isSessionBrokerCommand(command: string): command is SessionBrokerCliCommand {
  return ["session-request-status", "abandon-session-request", "release-broker-session"].includes(
    command,
  );
}

/**
 * The usage error for a no-argument daemon command given a stray positional word or an unknown
 * option, or undefined when its arguments are valid. A word right after a value-taking flag is
 * that flag's value, so launch options such as `--port 3001` keep working after the command.
 */
export function daemonCommandArgumentError(command: string, args: string[]): string | undefined {
  const spec = Object.hasOwn(STRICT_DAEMON_COMMANDS, command)
    ? STRICT_DAEMON_COMMANDS[command]
    : undefined;
  if (!spec) {
    return undefined;
  }
  const invalid = invalidDaemonCommandArgument(args, spec);
  if (!invalid) {
    if (command === "capabilities" && !daemonCapabilitiesCommandArgsAreValid(args)) {
      return DAEMON_CAPABILITIES_COMMAND_USAGE;
    }
    if (isSessionBrokerCommand(command) && !sessionBrokerCommandArgsAreValid(command, args)) {
      return sessionBrokerCommandUsage(command);
    }
    return undefined;
  }
  if (isSessionBrokerCommand(command)) {
    return sessionBrokerCommandUsage(command);
  }
  if (invalid.kind === "positional") {
    return `Unexpected argument for daemon ${command}: ${invalid.argument}`;
  }
  return invalid.kind === "value"
    ? `Invalid value for daemon ${command} option ${invalid.argument}; expected true or false`
    : `Unknown option for daemon ${command}: ${invalid.argument}`;
}

export function printDaemonUsageError(message: string): void {
  try {
    console.error(message);
    console.log("\nAvailable commands:");
    console.log("  start                 Start the daemon");
    console.log("  stop                  Stop the daemon");
    console.log("  status                Check daemon status");
    console.log("  capabilities --json   Query the existing daemon's capability contract");
    console.log("  restart               Restart the daemon");
    console.log("  health                Check daemon health");
    console.log("  diagnose              Run full diagnostics");
    console.log("  available-devices     Query device pool status");
    console.log("  active-sessions       List held sessions and why each holds its device");
    console.log("  session-info <id>     Get information about a session");
    console.log("  release-session <id>  Release a session and free its device");
    console.log("  session-request-status <request-id> --liveness-owner-token <token> --json");
    console.log("  abandon-session-request <request-id> --liveness-owner-token <token> --json");
    console.log("  release-broker-session <session-uuid> --liveness-owner-token <token> --json");
    console.log(
      "  (capabilities requires --json; status, available-devices, active-sessions, session-info and release-session accept --json)",
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
