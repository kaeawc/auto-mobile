import { ActionableError } from "../../models/ActionableError";
import type {
  SessionBrokerReleaseResult,
  SessionBrokerResult,
} from "../../models/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { parseBooleanFlagValue, readValueOperand, splitFlagToken } from "../../utils/flagTokens";
import { z } from "zod";
import {
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
  DAEMON_SESSION_REQUEST_STATUS_METHOD,
} from "../sessionBrokerProxyAcquisition";

export const SESSION_BROKER_STATUS_TIMEOUT_MS = 5_000;
/** CLI request budget leaves room for long native reset and release paths. */
export const SESSION_BROKER_RELEASE_TIMEOUT_MS = 240_000;

export type SessionBrokerCliCommand = "session-request-status" | "release-broker-session";

export interface SessionBrokerCommandClient {
  connect(): Promise<void>;
  callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type SessionBrokerCommandClientFactory = () => SessionBrokerCommandClient;

export interface SessionBrokerCommandArgs {
  identity: string;
  livenessOwnerToken: string;
}

interface SessionBrokerArgumentState {
  identity?: string;
  livenessOwnerToken?: string;
  json: boolean;
}

const sessionUuid = z.string().uuid();

export function sessionBrokerCommandUsage(command: SessionBrokerCliCommand): string {
  const identity = command === "session-request-status" ? "<request-id>" : "<session-uuid>";
  return `Usage: ${command} ${identity} --liveness-owner-token <token> --json`;
}

/** Apply one command argument and return the last consumed index, or undefined on refusal. */
function consumeSessionBrokerCommandArg(
  args: string[],
  index: number,
  state: SessionBrokerArgumentState,
): number | undefined {
  const arg = args[index];
  if (!arg || arg === "--") {
    return undefined;
  }
  const { flag, inlineValue } = splitFlagToken(arg);
  if (flag === "--json") {
    if (state.json || parseBooleanFlagValue(inlineValue) !== true) {
      return undefined;
    }
    state.json = true;
    return index;
  }
  if (flag === "--liveness-owner-token") {
    const operand = readValueOperand(args, index);
    const token = operand.value?.trim();
    if (state.livenessOwnerToken !== undefined || !token) {
      return undefined;
    }
    state.livenessOwnerToken = token;
    return operand.last;
  }
  const identity = arg.trim();
  if ([arg.startsWith("-"), state.identity !== undefined, !identity].some(Boolean)) {
    return undefined;
  }
  state.identity = identity;
  return index;
}

/**
 * Parse the JSON-only session-broker consumer commands. The same parser backs preflight
 * validation and execution, and every refusal is deliberately value-free so an owner token
 * cannot be repeated in diagnostics.
 */
function readSessionBrokerCommandArgs(
  command: SessionBrokerCliCommand,
  args: string[],
): SessionBrokerCommandArgs | undefined {
  const state: SessionBrokerArgumentState = { json: false };

  for (let index = 0; index < args.length; index++) {
    const consumed = consumeSessionBrokerCommandArg(args, index, state);
    if (consumed === undefined) {
      return undefined;
    }
    index = consumed;
  }

  if (
    !state.identity ||
    !state.livenessOwnerToken ||
    !state.json ||
    (command === "release-broker-session" && !sessionUuid.safeParse(state.identity).success)
  ) {
    return undefined;
  }
  return { identity: state.identity, livenessOwnerToken: state.livenessOwnerToken };
}

export function sessionBrokerCommandArgsAreValid(
  command: SessionBrokerCliCommand,
  args: string[],
): boolean {
  return readSessionBrokerCommandArgs(command, args) !== undefined;
}

export function parseSessionBrokerCommandArgs(
  command: SessionBrokerCliCommand,
  args: string[],
): SessionBrokerCommandArgs {
  const parsed = readSessionBrokerCommandArgs(command, args);
  if (!parsed) {
    throw new ActionableError(sessionBrokerCommandUsage(command));
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBrokerFailure(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.code === "string" &&
      value.code.length > 0 &&
      typeof value.message === "string" &&
      typeof value.retryable === "boolean")
  );
}

function isStatusResult(value: unknown, requestId: string): value is SessionBrokerResult {
  if (!isRecord(value)) {
    return false;
  }
  const outcome = value.outcome;
  const sessionUuid = value.sessionUuid;
  const profile = value.profile;
  const validEnvelope = [
    value.contractVersion === 1,
    value.requestId === requestId,
    ["ready", "pending", "released", "failed"].includes(String(outcome)),
    sessionUuid === null || (typeof sessionUuid === "string" && sessionUuid.length > 0),
    profile === null || isRecord(profile),
    typeof value.cleanupPending === "boolean",
    isBrokerFailure(value.failure),
  ].every(Boolean);
  if (!validEnvelope) {
    return false;
  }
  return outcome !== "ready" || (typeof sessionUuid === "string" && isRecord(profile));
}

function isReleaseResult(value: unknown, sessionUuid: string): value is SessionBrokerReleaseResult {
  if (!isRecord(value)) {
    return false;
  }
  return [
    value.sessionUuid === sessionUuid,
    ["released", "cleanup_pending", "unknown_session"].includes(String(value.outcome)),
  ].every(Boolean);
}

function redactError(error: unknown, token: string): Error {
  const redact = (value: unknown): unknown =>
    typeof value === "string" ? value.replaceAll(token, "[REDACTED]") : value;
  const source = isRecord(error) ? error : {};
  return Object.assign(new ActionableError(String(redact(errorMessage(error)))), {
    code: redact(source.code),
    nextAction: redact(source.nextAction),
    retryable: source.retryable,
    retryAfterMs: source.retryAfterMs,
    releaseReason: redact(source.releaseReason),
    idle: source.idle,
  });
}

async function callExistingDaemon(
  createClient: SessionBrokerCommandClientFactory,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const client = createClient();
  try {
    await client.connect();
    return await client.callDaemonMethod(method, params, { timeoutMs });
  } finally {
    await client.close();
  }
}

export async function queryBrokerSessionRequestStatus(
  args: string[],
  createClient: SessionBrokerCommandClientFactory,
): Promise<SessionBrokerResult> {
  const parsed = parseSessionBrokerCommandArgs("session-request-status", args);
  try {
    const result = await callExistingDaemon(
      createClient,
      DAEMON_SESSION_REQUEST_STATUS_METHOD,
      {
        requestId: parsed.identity,
        livenessOwnerToken: parsed.livenessOwnerToken,
      },
      SESSION_BROKER_STATUS_TIMEOUT_MS,
    );
    if (!isStatusResult(result, parsed.identity)) {
      throw new ActionableError("Invalid daemon session-request-status result");
    }
    return result;
  } catch (error) {
    throw redactError(error, parsed.livenessOwnerToken);
  }
}

export async function releaseBrokerSession(
  args: string[],
  createClient: SessionBrokerCommandClientFactory,
): Promise<SessionBrokerReleaseResult> {
  const parsed = parseSessionBrokerCommandArgs("release-broker-session", args);
  try {
    const result = await callExistingDaemon(
      createClient,
      DAEMON_RELEASE_BROKER_SESSION_METHOD,
      {
        sessionId: parsed.identity,
        livenessOwnerToken: parsed.livenessOwnerToken,
      },
      SESSION_BROKER_RELEASE_TIMEOUT_MS,
    );
    if (!isReleaseResult(result, parsed.identity)) {
      throw new ActionableError("Invalid daemon release-broker-session result");
    }
    return result;
  } catch (error) {
    throw redactError(error, parsed.livenessOwnerToken);
  }
}
