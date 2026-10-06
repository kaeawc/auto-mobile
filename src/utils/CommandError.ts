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

function textFrom(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return "";
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
