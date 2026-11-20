import { errorMessage } from "./describeUnknownError";
export interface CommandErrorFormatOptions {
  command: string;
  args?: string[];
  cwd?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

const MAX_COMMAND_OUTPUT_CHARS = 300;
const TRUNCATED_MARKER = "...[truncated]";
const MAX_COMMAND_CAUSE_DEPTH = 5;

function textFrom(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return "";
}

/** Read raw streams and exit status through wrappers without matching their command-line messages. */
export function commandFailureDetails(error: unknown): {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  let current = error;
  for (let depth = 0; depth < MAX_COMMAND_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const failure = current as Error & { stdout?: unknown; stderr?: unknown; code?: unknown };
    stdout.push(textFrom(failure.stdout));
    stderr.push(textFrom(failure.stderr));
    if (typeof failure.code === "number") {
      exitCode ??= failure.code;
    }
    current = current.cause;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

function outputExcerpt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return trimmed;
  }
  return `${TRUNCATED_MARKER}${trimmed.slice(-(MAX_COMMAND_OUTPUT_CHARS - TRUNCATED_MARKER.length))}`;
}

// Short raw-error and stderr labels retain the existing diagnostic format.
function outputLabelLimit(value: string): number {
  return value.trim().length > MAX_COMMAND_OUTPUT_CHARS ? MAX_COMMAND_OUTPUT_CHARS : 4000;
}

function commandLine(command: string, args: string[] = []): string {
  return [command, ...args].join(" ");
}

export function formatCommandError(error: unknown, options: CommandErrorFormatOptions): string {
  const err = (error ?? {}) as NodeJS.ErrnoException & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    signal?: NodeJS.Signals;
  };
  const baseMessage = outputExcerpt(errorMessage(error));
  const stdout = textFrom(options.stdout) || textFrom(err.stdout);
  const stderr = textFrom(options.stderr) || textFrom(err.stderr);
  const lines = [`Command failed: ${commandLine(options.command, options.args)}`];

  if (options.cwd) {
    lines.push(`cwd: ${options.cwd}`);
  }
  if (typeof err.code === "number") {
    lines.push(`exit code: ${err.code}`);
  } else if (typeof err.code === "string") {
    lines.push(`error code: ${err.code}`);
  }
  if (err.signal) {
    lines.push(`signal: ${err.signal}`);
  }
  lines.push(`raw error: (last ${outputLabelLimit(errorMessage(error))} chars) ${baseMessage}`);
  if (stdout.trim().length > 0) {
    lines.push(
      `stdout: (last ${MAX_COMMAND_OUTPUT_CHARS} chars; ${Buffer.byteLength(stdout)} bytes${stdout.trim().length > MAX_COMMAND_OUTPUT_CHARS ? "; truncated" : ""})`,
      outputExcerpt(stdout),
    );
  }
  if (stderr.trim().length > 0) {
    lines.push(`stderr: (last ${outputLabelLimit(stderr)} chars)`, outputExcerpt(stderr));
  }

  return lines.join("\n");
}

export function wrapCommandError(error: unknown, options: CommandErrorFormatOptions): Error {
  const wrapped = new Error(formatCommandError(error, options), { cause: error });
  if (error instanceof Error) {
    wrapped.name = error.name;
  }
  return wrapped;
}
