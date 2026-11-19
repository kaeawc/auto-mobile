import { AsyncLocalStorage } from "node:async_hooks";
import type { BootedDevice } from "../../models";
import type { Timer } from "../SystemTimer";
import {
  capturedDeviceOf,
  FIXTURE_CAPTURE_SCHEMA_VERSION,
  REDACTED_COMMAND_ARG,
  type CapturedCommand,
  type CapturedDevice,
} from "./fixtureCaptureFormat";
import type { FixtureCaptureWriter } from "./FixtureCaptureWriter";

/**
 * Fixture capture mode (#18770): while a tool call runs inside {@link runWithFixtureCapture},
 * every host command that goes through the shared exec seam is recorded against that call and
 * written out when it settles. Off unless `AUTOMOBILE_CAPTURE_FIXTURES_DIR` is set; with it unset
 * no scope exists and {@link beginCapturedCommand} returns undefined.
 */
export interface FixtureCaptureDeps {
  writer: FixtureCaptureWriter;
  timer: Pick<Timer, "now">;
  automobileVersion: () => string;
}

class ToolCallCaptureScope {
  readonly commands: CapturedCommand[] = [];
  device: CapturedDevice | undefined;
  private readonly startMs: number;

  constructor(
    readonly toolName: string,
    readonly deps: FixtureCaptureDeps,
  ) {
    this.startMs = deps.timer.now();
  }

  async flush(): Promise<void> {
    await this.deps.writer.write({
      provenance: {
        schemaVersion: FIXTURE_CAPTURE_SCHEMA_VERSION,
        tool: { name: this.toolName },
        captureDate: new Date(this.startMs).toISOString(),
        automobileVersion: this.deps.automobileVersion(),
        ...(this.device ? { device: this.device } : {}),
      },
      commands: this.commands,
    });
  }
}

interface CaptureStore {
  scope: ToolCallCaptureScope;
  /** Set while a command that carries password input runs; replaces its argv. */
  redactLabel?: string;
}

const captureStorage = new AsyncLocalStorage<CaptureStore>();

/**
 * Run one tool call. Without deps this is exactly `fn()`. With deps, commands issued inside `fn`
 * are attributed to `toolName`; a nested tool call opens its own scope, so each command belongs
 * to the innermost tool call that issued it. The capture is written once `fn` settles, whether it
 * resolved or threw.
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
 * The outcome of one host command, as the exec seam observed it: its output, or the thrown exec
 * error, whose `stdout`/`stderr`/`code`/`signal` fields node's execFile sets.
 */
export type CapturedCommandOutcome =
  | { stdout: string | Buffer; stderr: string | Buffer }
  | { error: unknown };

export interface CapturedCommandHandle {
  finish(outcome: CapturedCommandOutcome): void;
}

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

/** Start recording a command; undefined (and free) outside a capture scope. */
export function beginCapturedCommand(
  argv: readonly string[],
  cwd?: string,
): CapturedCommandHandle | undefined {
  const store = captureStorage.getStore();
  if (!store) {
    return undefined;
  }
  const { scope, redactLabel } = store;
  const startMs = scope.deps.timer.now();
  return {
    finish(outcome) {
      scope.commands.push({
        index: scope.commands.length,
        argv: redactLabel === undefined ? [...argv] : [argv[0] ?? "", REDACTED_COMMAND_ARG],
        ...(cwd === undefined ? {} : { cwd }),
        ...outcomeFields(outcome),
        durationMs: scope.deps.timer.now() - startMs,
        ...(redactLabel === undefined ? {} : { redacted: true as const }),
      });
    },
  };
}
