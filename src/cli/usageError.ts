import { cliOptions } from "./parseArgs";

/** Mode flags that take over argv: everything after one belongs to that mode. */
const MODE_FLAGS: readonly string[] = ["--cli", "--daemon", "--boot-device"];

const DAEMON_COMMANDS = [
  "start",
  "stop",
  "status",
  "restart",
  "health",
  "diagnose",
  "available-devices",
  "session-info <id>",
  "release-session <id>",
  "heartbeat <id>",
];

const DAEMON_COMMAND_NAMES = new Set(DAEMON_COMMANDS.map((command) => command.split(" ")[0]));

const BOOT_DEVICE_FORM = "auto-mobile --boot-device --platform <android|ios>";

/** `--flag=value` for a mode flag, e.g. `--cli=observe`, which no dispatcher recognizes. */
function malformedModeFlag(args: string[]): string | undefined {
  return args.find((arg) => MODE_FLAGS.some((flag) => arg.startsWith(`${flag}=`)));
}

function describeMalformedModeFlag(arg: string): string {
  const [flag, ...rest] = arg.split("=");
  const form =
    flag === "--boot-device" ? BOOT_DEVICE_FORM : `auto-mobile ${flag} ${rest.join("=")}`.trim();
  return (
    `Unknown option '${arg}': ${flag} takes its value as the next argument, not after '='.\n` +
    `Did you mean: ${form}`
  );
}

function isKnownBooleanOption(arg: string): boolean {
  const name = arg.replace(/^-+/, "");
  const options: Record<string, { type: string }> = cliOptions;
  return Object.hasOwn(options, name) && options[name].type === "boolean";
}

/** Bare words before the first mode flag that are not the value of any option. */
function strayWords(args: string[]): string[] {
  const words: string[] = [];
  let valueExpected = false;
  for (const arg of args) {
    if (MODE_FLAGS.includes(arg) || arg === "--") {
      break;
    }
    if (!arg.startsWith("-")) {
      if (!valueExpected) {
        words.push(arg);
      }
      valueExpected = false;
      continue;
    }
    // A known boolean flag consumes nothing. Value flags, and flags this
    // module does not know (parsed by hand elsewhere), may consume the next
    // token, so it is never reported: rejecting a real option value would
    // break an installed client's launch.
    valueExpected = !arg.includes("=") && !isKnownBooleanOption(arg);
  }
  return words;
}

function describeStrayWord(word: string): string {
  const form = DAEMON_COMMAND_NAMES.has(word) ? `--daemon ${word}` : `--cli ${word}`;
  return (
    `Unexpected argument '${word}'.\nDid you mean: auto-mobile ${form}\n` +
    "Run auto-mobile with no arguments to start the MCP server over stdio."
  );
}

function missingDaemonCommand(args: string[]): boolean {
  const boundary = args.findIndex((arg) => MODE_FLAGS.includes(arg));
  return boundary >= 0 && args[boundary] === "--daemon" && args[boundary + 1] === undefined;
}

/**
 * Explain why argv is not a recognized command line, or return undefined when
 * the process should proceed (including the no-argument stdio MCP launch).
 * A command line that names a mode but is not understood must fail loudly
 * rather than fall through to the stdio server and wait on stdin (#10132).
 */
export function findUsageError(args: string[]): string | undefined {
  const malformed = malformedModeFlag(args);
  if (malformed !== undefined) {
    return describeMalformedModeFlag(malformed);
  }
  if (missingDaemonCommand(args)) {
    return (
      "--daemon requires a command.\nAvailable commands:\n" +
      DAEMON_COMMANDS.map((command) => `  ${command}`).join("\n") +
      "\nExample: auto-mobile --daemon status"
    );
  }
  const [firstWord] = strayWords(args);
  return firstWord === undefined ? undefined : describeStrayWord(firstWord);
}
