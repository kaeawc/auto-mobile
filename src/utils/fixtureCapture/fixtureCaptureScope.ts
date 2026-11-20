import { AsyncLocalStorage } from "node:async_hooks";
import type { BootedDevice } from "../../models";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { Timer } from "../SystemTimer";
import {
  capturedDeviceOf,
  FIXTURE_CAPTURE_SCHEMA_VERSION,
  MAX_CAPTURED_CALL_CHARS,
  MAX_CAPTURED_STREAM_CHARS,
  REDACTED_COMMAND_ARG,
  TRUNCATED_OUTPUT_MARKER,
  type CapturedCommand,
  type CapturedDevice,
  type CaptureSourceTreeState,
} from "./fixtureCaptureFormat";
import type { FixtureCaptureWriter } from "./FixtureCaptureWriter";

/**
 * Fixture capture mode (#18770): while a tool call runs inside {@link runWithFixtureCapture},
 * every host command that goes through the shared exec seam is recorded against that call and
 * written out when it settles. Off unless `AUTOMOBILE_CAPTURE_FIXTURES_DIR` is set; with it unset
 * no scope exists and {@link beginCapturedCommand} returns undefined.
 */
export interface CaptureSourceIdentity {
  automobileVersion: string;
  sourceTreeState: CaptureSourceTreeState;
}

export interface CaptureLimits {
  /** Most characters kept from one stream of one command. */
  streamChars: number;
  /** Most stdout plus stderr characters kept across one tool call. */
  callChars: number;
}

export interface FixtureCaptureDeps {
  writer: FixtureCaptureWriter;
  timer: Pick<Timer, "now">;
  /** The settled source identity; awaited when the capture is written. */
  sourceIdentity: () => Promise<CaptureSourceIdentity>;
  /** Defaults to {@link MAX_CAPTURED_STREAM_CHARS} and {@link MAX_CAPTURED_CALL_CHARS}. */
  limits?: CaptureLimits;
}

const DEFAULT_LIMITS: CaptureLimits = {
  streamChars: MAX_CAPTURED_STREAM_CHARS,
  callChars: MAX_CAPTURED_CALL_CHARS,
};

const UNKNOWN_SOURCE: CaptureSourceIdentity = {
  automobileVersion: "unknown",
  sourceTreeState: "unknown",
};

type Scrub = (text: string) => string;

/** A stream already cut at the per-stream limit; the call budget is applied at close. */
interface StreamCut {
  text: string;
  cut: boolean;
}

/** A finished command whose output still awaits the per-call budget. */
interface PendingCommand extends Omit<CapturedCommand, "stdout" | "stderr" | "truncated"> {
  stdout: StreamCut;
  stderr: StreamCut;
  /** Output was cut before capture saw it (node's maxBuffer), so it is incomplete. */
  incomplete: boolean;
}

class ToolCallCaptureScope {
  private commands: PendingCommand[] = [];
  private issued = 0;
  private closedFlag = false;
  device: CapturedDevice | undefined;
  private readonly startMs: number;
  private readonly limits: CaptureLimits;

  constructor(
    readonly toolName: string,
    readonly deps: FixtureCaptureDeps,
  ) {
    this.startMs = deps.timer.now();
    this.limits = deps.limits ?? DEFAULT_LIMITS;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Reserve the next ordinal when a command starts, so indices follow issue order. */
  reserveIndex(): number {
    return this.issued++;
  }

  /** Dropped once the scope is closed: background work started in the call outlives it. */
  record(command: PendingCommand): void {
    if (!this.closedFlag) {
      this.commands.push(command);
    }
  }

  /** Keep at most the per-stream limit; the per-call limit is applied in issue order at close. */
  cutStream(value: string): StreamCut {
    return value.length > this.limits.streamChars
      ? { text: value.slice(0, this.limits.streamChars), cut: true }
      : { text: value, cut: false };
  }

  /**
   * Close the scope and release its command list; later records are ignored. Concurrent
   * commands finish out of order, so they are sorted by issue order first and the per-call
   * budget is spent in that order: which command loses output never depends on timing.
   */
  private close(): CapturedCommand[] {
    this.closedFlag = true;
    const pending = this.commands.sort((left, right) => left.index - right.index);
    this.commands = [];
    let keptChars = 0;
    const bound = (stream: StreamCut): { text: string; truncated: boolean } => {
      const kept = Math.min(stream.text.length, Math.max(0, this.limits.callChars - keptChars));
      keptChars += kept;
      return stream.cut || kept < stream.text.length
        ? { text: `${stream.text.slice(0, kept)}${TRUNCATED_OUTPUT_MARKER}`, truncated: true }
        : { text: stream.text, truncated: false };
    };
    return pending.map(({ stdout: rawStdout, stderr: rawStderr, incomplete, ...command }) => {
      const stdout = bound(rawStdout);
      const stderr = bound(rawStderr);
      const truncated = incomplete || stdout.truncated || stderr.truncated;
      return {
        ...command,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(truncated ? { truncated: true as const } : {}),
      };
    });
  }

  async flush(): Promise<void> {
    const commands = this.close();
    await this.deps.writer.write({
      provenance: {
        schemaVersion: FIXTURE_CAPTURE_SCHEMA_VERSION,
        tool: { name: this.toolName },
        captureDate: new Date(this.startMs).toISOString(),
        ...(await this.sourceIdentity()),
        ...(this.device ? { device: this.device } : {}),
      },
      commands,
    });
  }

  private async sourceIdentity(): Promise<CaptureSourceIdentity> {
    try {
      return await this.deps.sourceIdentity();
    } catch (error) {
      // An unknown source cannot be promoted, so the capture stays safe to write.
      logger.warn(`Fixture capture could not resolve the source version: ${errorMessage(error)}`);
      return UNKNOWN_SOURCE;
    }
  }
}

interface CaptureStore {
  scope: ToolCallCaptureScope;
  /** Set while a command that carries password input runs; replaces its argv. */
  redactLabel?: string;
  /** Secret scrubbers the caller also applies to its logs, innermost last. */
  scrubs?: readonly Scrub[];
}

const captureStorage = new AsyncLocalStorage<CaptureStore>();

/**
 * Run one tool call. Without deps this is exactly `fn()`. With deps, commands issued inside `fn`
 * are attributed to `toolName`; a nested tool call opens its own scope, so each command belongs
 * to the innermost tool call that issued it. The capture is written once `fn` settles, whether it
 * resolved or threw; from then on the scope is closed and records nothing more.
 */
export async function runWithFixtureCapture<T>(
  toolName: string,
  deps: FixtureCaptureDeps | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!deps) {
    return fn();
  }
  const scope = new ToolCallCaptureScope(toolName, deps);
  try {
    return await captureStorage.run({ scope }, fn);
  } finally {
    await scope.flush();
  }
}

/**
 * Run `fn` outside any capture scope. Background loops a tool call starts (the performance
 * sampler's interval) use it so their commands are never attributed to that call.
 */
export function outsideFixtureCapture<T>(fn: () => T): T {
  return captureStorage.exit(fn);
}

/** Record the device the current tool call resolved; a no-op outside a capture scope. */
export function noteFixtureCaptureDevice(device: BootedDevice | undefined): void {
  const scope = captureStorage.getStore()?.scope;
  if (scope && device) {
    scope.device = capturedDeviceOf(device);
  }
}

/**
 * Run `fn` so any command it issues is recorded with argv replaced by
 * {@link REDACTED_COMMAND_ARG}. Callers pass the same label they use to keep the command out of
 * logs (`AdbExecuteOptions.logLabel`). Outside a capture scope this is exactly `fn()`.
 */
export function withFixtureCaptureRedaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const store = captureStorage.getStore();
  return store ? captureStorage.run({ ...store, redactLabel: label }, fn) : fn();
}

/**
 * Run `fn` so `scrub` (the scrubber the caller applies to its logs) is applied to the argv,
 * stdout and stderr of every command it issues before they are recorded. A command whose text
 * the scrubber changed is marked `redacted`. Outside a capture scope this is exactly `fn()`.
 */
export function withFixtureCaptureScrub<T>(scrub: Scrub, fn: () => Promise<T>): Promise<T> {
  const store = captureStorage.getStore();
  return store
    ? captureStorage.run({ ...store, scrubs: [...(store.scrubs ?? []), scrub] }, fn)
    : fn();
}

/**
 * The outcome of one host command, as the exec seam observed it: its output, or the thrown exec
 * error, whose `stdout`/`stderr`/`code`/`signal` fields node's execFile sets.
 */
export type CapturedCommandOutcome =
  | { stdout: string | Buffer; stderr: string | Buffer }
  | { error: unknown };

export interface CapturedCommandHandle {
  finish(outcome: CapturedCommandOutcome): void;
}

/**
 * Node's execFile code when a stream outgrew `maxBuffer`: it kills the child and hands back only
 * what fit, which can be exactly the stream limit, so the length alone cannot show the cut.
 */
const MAX_BUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString() : "";
}

type OutcomeFields = Pick<
  CapturedCommand,
  "exitCode" | "signal" | "errorCode" | "stdout" | "stderr"
>;

function outcomeFields(outcome: CapturedCommandOutcome): OutcomeFields {
  if (!("error" in outcome)) {
    return { exitCode: 0, stdout: text(outcome.stdout), stderr: text(outcome.stderr) };
  }
  const fields: Record<string, unknown> =
    typeof outcome.error === "object" && outcome.error !== null ? { ...outcome.error } : {};
  const { code, signal } = fields;
  return {
    exitCode: typeof code === "number" ? code : null,
    ...(typeof signal === "string" ? { signal } : {}),
    ...(typeof code === "string" ? { errorCode: code } : {}),
    stdout: text(fields.stdout),
    stderr: text(fields.stderr),
  };
}

interface ScrubbedText {
  argv: string[];
  stdout: string;
  stderr: string;
  changed: boolean;
}

/** Apply every scrubber before any truncation, so a cut can never leave part of a secret. */
function scrubbed(argv: string[], fields: OutcomeFields, scrubs: readonly Scrub[]): ScrubbedText {
  const scrub = (value: string) => scrubs.reduce((current, apply) => apply(current), value);
  const result = {
    argv: argv.map(scrub),
    stdout: scrub(fields.stdout),
    stderr: scrub(fields.stderr),
  };
  const changed =
    result.stdout !== fields.stdout ||
    result.stderr !== fields.stderr ||
    result.argv.some((arg, index) => arg !== argv[index]);
  return { ...result, changed };
}

function recordedArgv(argv: readonly string[], redactLabel: string | undefined): string[] {
  return redactLabel === undefined ? [...argv] : [argv[0] ?? "", REDACTED_COMMAND_ARG];
}

/** Start recording a command; undefined (and free) outside an open capture scope. */
export function beginCapturedCommand(
  argv: readonly string[],
  cwd?: string,
): CapturedCommandHandle | undefined {
  const store = captureStorage.getStore();
  if (!store || store.scope.closed) {
    return undefined;
  }
  const { scope, redactLabel, scrubs = [] } = store;
  const startMs = scope.deps.timer.now();
  const index = scope.reserveIndex();
  return {
    finish(outcome) {
      if (scope.closed) {
        return;
      }
      const fields = outcomeFields(outcome);
      const clean = scrubbed(recordedArgv(argv, redactLabel), fields, scrubs);
      const redacted = redactLabel !== undefined || clean.changed;
      scope.record({
        index,
        argv: clean.argv,
        ...(cwd === undefined ? {} : { cwd }),
        ...fields,
        stdout: scope.cutStream(clean.stdout),
        stderr: scope.cutStream(clean.stderr),
        incomplete: fields.errorCode === MAX_BUFFER_ERROR_CODE,
        durationMs: scope.deps.timer.now() - startMs,
        ...(redacted ? { redacted: true as const } : {}),
      });
    },
  };
}
