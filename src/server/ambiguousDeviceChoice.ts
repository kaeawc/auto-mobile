import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ambiguousDeviceCandidates, deviceChoiceRequest } from "./ambiguousDeviceElicitation";
import type { ToolCall } from "./toolCallDispatch";

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
): Promise<Result | Pending> {
  const result = await execute(call);
  const candidates = ambiguousDeviceCandidates(result);
  if (!candidates) {
    return result;
  }
  const reply = await ask({
    candidates,
    inputRequests: {
      deviceChoice: inputRequired.elicit(deviceChoiceRequest(call.name, candidates)),
    },
  });
  if (!reply) {
    return result;
  }
  if ("pending" in reply) {
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
  return answer ? execute({ ...call, args: { ...call.args, deviceId: answer.deviceId } }) : result;
}
