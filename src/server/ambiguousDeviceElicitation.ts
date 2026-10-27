import type {
  ElicitRequestFormParams,
  ElicitResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { AMBIGUOUS_DEVICE_TARGET_CODE } from "../daemon/ambiguousDeviceTargetRefusal";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  classifyElicitationDeclaration,
  telemetryElicitationRecorder,
  type ElicitationDeclared,
  type ElicitationOutcome,
  type ElicitationRecorder,
} from "./elicitationOutcome";
import type { ToolCall, ToolCallBackend, ToolCallExtra, ToolCallRequest } from "./toolCallDispatch";

/**
 * How long a connected client gets to pick a device before the call answers with the plain
 * `ambiguous_device_target` refusal (#13945). Short on purpose: an unattended harness that
 * declares elicitation but has nobody to answer must not hold a tool call open.
 */
export const AMBIGUOUS_DEVICE_ELICITATION_TIMEOUT_MS = 20_000;

export interface AmbiguousDeviceElicitationOptions {
  readonly timer?: Timer;
  readonly timeoutMs?: number;
  /** Where each ambiguous-device refusal and its outcome is recorded (#15588). */
  readonly recorder?: ElicitationRecorder;
}

interface DeviceCandidate {
  readonly deviceId: string;
  readonly platform: string;
}

/** What one connection offers: whether it can be asked, and the ask itself. */
export interface DeviceChoicePeer {
  declaresElicitation(): boolean;
  /** What the client declared; derived from {@link declaresElicitation} when a peer omits it. */
  declaration?(): ElicitationDeclared;
  elicit(params: ElicitRequestFormParams, signal: AbortSignal): Promise<ElicitResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Form-mode elicitation is declared as `elicitation.form`, or by a bare `elicitation: {}` (the
 * pre-mode spelling). A URL-only declaration cannot show a device list.
 */
export function declaresFormElicitation(capabilities: unknown): boolean {
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined;
  if (!isRecord(elicitation)) {
    return false;
  }
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/**
 * The connection's peer. Capabilities are read per connection (the server instance is one
 * client's) and nothing is remembered. A 2026-07-28 request uses MRTR instead of this push
 * channel.
 */
export function deviceChoicePeerFor(server: McpServer, ctx: ServerContext): DeviceChoicePeer {
  return {
    declaresElicitation: () =>
      ctx.mcpReq.envelope === undefined &&
      declaresFormElicitation(server.server.getClientCapabilities()),
    declaration: () =>
      ctx.mcpReq.envelope === undefined
        ? classifyElicitationDeclaration(server.server.getClientCapabilities())
        : "none",
    elicit: (params, signal) =>
      server.server.request({ method: "elicitation/create", params }, { signal }),
  };
}

const refusalResultSchema = z.object({
  isError: z.literal(true),
  content: z.array(z.looseObject({ type: z.string() })).min(1),
});

const refusalPayloadSchema = z.object({
  code: z.literal(AMBIGUOUS_DEVICE_TARGET_CODE),
  candidates: z.array(z.object({ deviceId: z.string(), platform: z.string().default("unknown") })),
});

const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

function refusalPayloadOf(result: unknown): z.infer<typeof refusalPayloadSchema> | undefined {
  const shape = refusalResultSchema.safeParse(result);
  const block = shape.success ? textBlockSchema.safeParse(shape.data.content[0]) : undefined;
  if (!block?.success || !block.data.text.includes(AMBIGUOUS_DEVICE_TARGET_CODE)) {
    return undefined;
  }
  try {
    const payload = refusalPayloadSchema.safeParse(JSON.parse(block.data.text));
    return payload.success ? payload.data : undefined;
  } catch (error) {
    // Free text that merely mentions the code is not the typed refusal; leave the result alone.
    logger.debug(`ambiguous device result is not JSON: ${errorMessage(error)}`);
    return undefined;
  }
}

/** The candidates of a typed `ambiguous_device_target` result, or undefined for any other result. */
export function ambiguousDeviceCandidates(result: unknown): readonly DeviceCandidate[] | undefined {
  const byId = new Map(
    (refusalPayloadOf(result)?.candidates ?? []).map((candidate) => [
      candidate.deviceId,
      candidate,
    ]),
  );
  return byId.size > 1 ? [...byId.values()] : undefined;
}

export function deviceChoiceRequest(
  toolName: string,
  candidates: readonly DeviceCandidate[],
): ElicitRequestFormParams {
  return {
    mode: "form",
    message: `${toolName} matched ${candidates.length} devices. Which device should it use?`,
    requestedSchema: {
      type: "object",
      properties: {
        deviceId: {
          type: "string",
          title: "Device",
          description: "The device this call should run on.",
          oneOf: candidates.map(({ deviceId, platform }) => ({
            const: deviceId,
            title: `${deviceId} (${platform})`,
          })),
        },
      },
      required: ["deviceId"],
    },
  };
}

/** The accepted choice, only if it names one of the offered devices (the answer is client input). */
function acceptedDeviceId(
  result: ElicitResult,
  candidates: readonly DeviceCandidate[],
): string | undefined {
  if (result.action !== "accept") {
    return undefined;
  }
  const chosen = result.content?.deviceId;
  return typeof chosen === "string" && candidates.some(({ deviceId }) => deviceId === chosen)
    ? chosen
    : undefined;
}

export interface DeviceChoiceAnswer {
  /** Present only for an accepted choice that names an offered device. */
  readonly deviceId?: string;
  readonly outcome: Extract<
    ElicitationOutcome,
    "accept" | "decline" | "cancel" | "timeout" | "invalid" | "error"
  >;
}

function answerOutcome(
  result: ElicitResult,
  candidates: readonly DeviceCandidate[],
): DeviceChoiceAnswer {
  if (result.action !== "accept") {
    return { outcome: result.action };
  }
  const deviceId = acceptedDeviceId(result, candidates);
  return deviceId === undefined ? { outcome: "invalid" } : { outcome: "accept", deviceId };
}

/**
 * Asks the client which device to use, bounded by `timeoutMs` on the injected timer. The answer
 * carries the chosen deviceId only for an accepted, offered choice; for decline, cancel, timeout,
 * a refused ask or a cancelled call the caller returns the original typed refusal unchanged.
 */
export async function askDeviceChoice(
  peer: DeviceChoicePeer,
  toolName: string,
  candidates: readonly DeviceCandidate[],
  options: { timer: Timer; timeoutMs: number; callSignal: AbortSignal },
): Promise<DeviceChoiceAnswer> {
  const asking = new AbortController();
  let timedOut = false;
  const stopAsking = () => asking.abort();
  options.callSignal.addEventListener("abort", stopAsking, { once: true });
  const deadline = options.timer.setTimeout(() => {
    timedOut = true;
    stopAsking();
  }, options.timeoutMs);
  try {
    const result = await peer.elicit(deviceChoiceRequest(toolName, candidates), asking.signal);
    return answerOutcome(result, candidates);
  } catch (error) {
    if (asking.signal.aborted) {
      // Timeout or a cancelled call is the expected unattended outcome, not a failure.
      logger.debug(`device choice for ${toolName} not answered: ${errorMessage(error)}`);
      return { outcome: timedOut ? "timeout" : "cancel" };
    }
    logger.warn(`device choice elicitation for ${toolName} failed: ${errorMessage(error)}`, error);
    return { outcome: "error" };
  } finally {
    options.timer.clearTimeout(deadline);
    options.callSignal.removeEventListener("abort", stopAsking);
  }
}

/** {@link askDeviceChoice} reduced to the chosen deviceId, or undefined for any other outcome. */
export async function elicitDeviceChoice(
  peer: DeviceChoicePeer,
  toolName: string,
  candidates: readonly DeviceCandidate[],
  options: { timer: Timer; timeoutMs: number; callSignal: AbortSignal },
): Promise<string | undefined> {
  return (await askDeviceChoice(peer, toolName, candidates, options)).deviceId;
}

/**
 * Wraps a backend so an `ambiguous_device_target` result becomes a device question for a client
 * that declared elicitation, then one retry with the chosen `deviceId`. Everything else, including
 * every non-accept outcome, returns the backend's result untouched (#13945).
 */
export function withAmbiguousDeviceElicitation<
  Req extends ToolCallRequest,
  Extra extends ToolCallExtra & { readonly signal: AbortSignal },
  Result,
>(
  backend: ToolCallBackend<Req, Extra, Result>,
  peer: DeviceChoicePeer,
  options: AmbiguousDeviceElicitationOptions = {},
): ToolCallBackend<Req, Extra, Result> {
  const timer = options.timer ?? defaultTimer;
  const timeoutMs = options.timeoutMs ?? AMBIGUOUS_DEVICE_ELICITATION_TIMEOUT_MS;
  const recorder = options.recorder ?? telemetryElicitationRecorder;
  const declarationOf = (): ElicitationDeclared =>
    peer.declaration?.() ?? (peer.declaresElicitation() ? "form" : "none");
  return {
    ...backend,
    execute: async (call: ToolCall<Extra>) => {
      const result = await backend.execute(call);
      if (call.args.deviceId !== undefined) {
        return result;
      }
      const candidates = ambiguousDeviceCandidates(result);
      if (!candidates) {
        return result;
      }
      const base = {
        toolName: call.name,
        era: "legacy",
        declared: declarationOf(),
        candidateCount: candidates.length,
      } as const;
      if (!peer.declaresElicitation()) {
        recorder.record({ ...base, outcome: "not_offered", atMs: timer.now() });
        return result;
      }
      const started = timer.now();
      const answer = await askDeviceChoice(peer, call.name, candidates, {
        timer,
        timeoutMs,
        callSignal: call.extra.signal,
      });
      const finished = timer.now();
      recorder.record({
        ...base,
        outcome: answer.outcome,
        atMs: finished,
        latencyMs: finished - started,
      });
      return answer.deviceId === undefined
        ? result
        : backend.execute({ ...call, args: { ...call.args, deviceId: answer.deviceId } });
    },
  };
}
