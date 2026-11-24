import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { AMBIENT_ENV, readEnvTrimmed } from "../../config/env";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { runExecSeam } from "../ExecSeam";
import { execFileAsync, type ExecFileAsync } from "../HostCommandExecutor";

/**
 * The active Xcode developer directory, as CoreSimulator wants it: `DEVELOPER_DIR` (an `.app`
 * path means its `Contents/Developer`), else the `xcode-select` link.
 */
export async function resolveDeveloperDirectory(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (target: string) => Promise<string> = realpath,
): Promise<string> {
  const selected = await resolve(
    readEnvTrimmed(AMBIENT_ENV.DEVELOPER_DIR, env) || "/var/db/xcode_select_link",
  );
  return selected.endsWith(".app") ? path.posix.join(selected, "Contents/Developer") : selected;
}

/** Codes the shared prelude prints as `{"error": code}` instead of running the body. */
export const CORE_SIMULATOR_JXA_FAILURES = [
  "private-api-unavailable",
  "device-not-found",
  "device-not-booted",
] as const;
export type CoreSimulatorJxaFailure = (typeof CORE_SIMULATOR_JXA_FAILURES)[number];

/** `SimDeviceState.booted`. */
const SIM_DEVICE_STATE_BOOTED = 3;

/**
 * The JavaScript for Automation script `osascript` runs. The shared prelude loads the system
 * CoreSimulator framework, gets the service context for `argv[0]` (the developer directory) and
 * its default device set, looks up `argv[1]` by NSUUID and, with `requireBooted`, requires the
 * device to be booted. Error out-parameters are passed as null: boxing the NSError a failed call
 * returns crashes the JXA bridge (osascript dies on SIGSEGV). `body` then runs with `argv` and
 * `device` in scope (the caller's arguments start at `argv[2]`) and returns its result as
 * `JSON.stringify(...)`. A separate process keeps the private framework out of the daemon.
 */
export function coreSimulatorJxaScript(body: string, requireBooted: boolean): string {
  const bootedCheck = requireBooted
    ? `\n  if (Number(device.state) !== ${SIM_DEVICE_STATE_BOOTED}) return JSON.stringify({ error: "device-not-booted" });`
    : "";
  return `
ObjC.import("Foundation");
function run(argv) {
  const developerDir = argv[0], udid = argv[1];
  const bundle = $.NSBundle.bundleWithPath("/Library/Developer/PrivateFrameworks/CoreSimulator.framework");
  if (bundle.isNil() || !bundle.load) return JSON.stringify({ error: "private-api-unavailable" });
  const contextClass = $.NSClassFromString("SimServiceContext");
  if (contextClass.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const context = contextClass.sharedServiceContextForDeveloperDirError($(developerDir), null);
  if (context.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const set = context.defaultDeviceSetWithError(null);
  if (set.isNil()) return JSON.stringify({ error: "private-api-unavailable" });
  const id = $.NSUUID.alloc.initWithUUIDString($(udid));
  const device = id.isNil() ? id : set.devicesByUDID.objectForKey(id);
  if (device.isNil()) return JSON.stringify({ error: "device-not-found" });${bootedCheck}
  ${body.trim()}
}
`;
}

const failureSchema = z.object({ error: z.enum(CORE_SIMULATOR_JXA_FAILURES) }).strict();

export interface CoreSimulatorJxaRequest<T> {
  udid: string;
  /** Statements run after the prelude; see {@link coreSimulatorJxaScript}. */
  body: string;
  /** The body's own arguments, from `argv[2]` on. */
  args: string[];
  requireBooted: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Schema of the JSON the body prints. */
  resultSchema: z.ZodType<T>;
  /** Names the call in errors: `Simulator <label> call failed on <udid>`. */
  label: string;
  /** Stands in for the script in captured commands and error context. */
  scriptPlaceholder: string;
  /** The message for a prelude failure code. */
  describeFailure: (failure: CoreSimulatorJxaFailure) => string;
}

/** The host seams {@link runCoreSimulatorJxa} uses; tests pass fakes. */
export interface CoreSimulatorJxaHost {
  exec: ExecFileAsync;
  developerDirectory: () => Promise<string>;
}

export const DEFAULT_CORE_SIMULATOR_JXA_HOST: CoreSimulatorJxaHost = {
  exec: execFileAsync,
  developerDirectory: () => resolveDeveloperDirectory(),
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    // Unparseable output falls through to the schema failure, which reports the text.
    return { unparseable: String(error) };
  }
}

/**
 * Runs one CoreSimulator `SimDevice` call in `osascript` and returns the body's parsed result.
 * A failed process, a prelude failure code and output matching neither contract are
 * {@link ActionableError}s.
 */
export async function runCoreSimulatorJxa<T>(
  request: CoreSimulatorJxaRequest<T>,
  host: CoreSimulatorJxaHost = DEFAULT_CORE_SIMULATOR_JXA_HOST,
): Promise<T> {
  const { udid, args, label, signal } = request;
  const script = coreSimulatorJxaScript(request.body, request.requireBooted);
  const argv = ["-l", "JavaScript", "-e", script, await host.developerDirectory(), udid, ...args];
  let stdout: string;
  try {
    const result = await runExecSeam(
      (execOptions) => host.exec("osascript", argv, execOptions),
      { timeoutMs: request.timeoutMs, ...(signal ? { signal } : {}) },
      {
        command: "osascript",
        args: ["-l", "JavaScript", request.scriptPlaceholder, udid, ...args],
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw toActionableError(error, `Simulator ${label} call failed on ${udid}`);
  }
  const output = parseJson(stdout);
  const failure = failureSchema.safeParse(output);
  if (failure.success) {
    throw new ActionableError(request.describeFailure(failure.data.error));
  }
  const parsed = request.resultSchema.safeParse(output);
  if (!parsed.success) {
    throw new ActionableError(
      `Simulator ${label} call on ${udid} printed unexpected output: ${stdout.trim().slice(0, 200)}`,
    );
  }
  return parsed.data;
}
