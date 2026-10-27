import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ambiguousDeviceCandidates, deviceChoiceRequest } from "./ambiguousDeviceElicitation";
import type {
  ElicitationDeclared,
  ElicitationOutcome,
  ElicitationRecorder,
} from "./elicitationOutcome";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { ToolCall } from "./toolCallDispatch";

/** Where a modern question's outcome is recorded; absent means nothing is recorded (#15588). */
export interface DeviceChoiceObserver {
  readonly recorder: ElicitationRecorder;
  readonly declared: ElicitationDeclared;
  readonly timer?: Timer;
}

type Candidates = NonNullable<ReturnType<typeof ambiguousDeviceCandidates>>;

export interface DeviceChoiceQuestion {
  readonly candidates: Candidates;
  readonly inputRequests: {
    readonly deviceChoice: ReturnType<typeof inputRequired.elicit>;
  };
}

type DeviceChoiceReply<Pending> =
  | { readonly pending: Pending }
  | {
      readonly responses: Readonly<Record<string, unknown>>;
      readonly offeredDeviceIds?: readonly string[];
    }
  | undefined;

/** Execute, ask on a typed refusal, and retry at most once with a validated device choice. */
export async function executeWithDeviceChoice<Extra, Result, Pending = never>(
  call: ToolCall<Extra>,
  execute: (call: ToolCall<Extra>) => Promise<Result>,
  ask: (question: DeviceChoiceQuestion) => Promise<DeviceChoiceReply<Pending>>,
  observer?: DeviceChoiceObserver,
): Promise<Result | Pending> {
  const result = await execute(call);
  const candidates = ambiguousDeviceCandidates(result);
  if (!candidates) {
    return result;
  }
  const timer = observer?.timer ?? defaultTimer;
  const started = timer.now();
  const note = (outcome: ElicitationOutcome, timed: boolean) => {
    const atMs = timer.now();
    observer?.recorder.record({
      toolName: call.name,
      era: "modern",
      declared: observer.declared,
      outcome,
      candidateCount: candidates.length,
      atMs,
      ...(timed ? { latencyMs: atMs - started } : {}),
    });
  };
  const reply = await ask({
    candidates,
    inputRequests: {
      deviceChoice: inputRequired.elicit(deviceChoiceRequest(call.name, candidates)),
    },
  });
  if (!reply) {
    note("not_offered", false);
    return result;
  }
  if ("pending" in reply) {
    note("asked", false);
    return reply.pending;
  }
  const answer = acceptedContent(
    reply.responses,
    "deviceChoice",
    z.object({
      deviceId: z
        .string()
        .refine(
          (id) =>
            candidates.some(({ deviceId }) => deviceId === id) &&
            (reply.offeredDeviceIds === undefined || reply.offeredDeviceIds.includes(id)),
        ),
    }),
  );
  note(answer ? "accept" : answerOutcome(reply.responses), true);
  return answer ? execute({ ...call, args: { ...call.args, deviceId: answer.deviceId } }) : result;
}

/** Why a response map did not yield a valid choice: the client's own action, else invalid. */
function answerOutcome(responses: Readonly<Record<string, unknown>>): ElicitationOutcome {
  const response = responses.deviceChoice;
  const action =
    typeof response === "object" && response !== null && "action" in response
      ? response.action
      : undefined;
  return action === "decline" || action === "cancel" ? action : "invalid";
}
