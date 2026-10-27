import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  ambiguousDeviceCandidates,
  declaresFormElicitation,
  deviceChoiceRequest,
} from "./ambiguousDeviceElicitation";
import type { McpToolCallExtra, ToolCallBackend, ToolCallRequest } from "./toolCallDispatch";

/** Modern requests ask in-band; no server state or push channel survives the HTTP exchange. */
export function withAmbiguousDeviceMrtr<Req extends ToolCallRequest, Result>(
  backend: ToolCallBackend<Req, McpToolCallExtra, Result>,
): ToolCallBackend<Req, McpToolCallExtra, Result | InputRequiredResult> {
  return {
    ...backend,
    execute: async (call) => {
      const result = await backend.execute(call);
      if (
        call.args.deviceId !== undefined ||
        !declaresFormElicitation(call.extra.envelope?.[CLIENT_CAPABILITIES_META_KEY])
      ) {
        return result;
      }
      const candidates = ambiguousDeviceCandidates(result);
      if (!candidates) {
        return result;
      }
      // Any retry response map ends the question flow, including empty or malformed answers.
      // Recompute candidates rather than trusting a client-echoed snapshot or requestState.
      if (call.extra.inputResponses !== undefined) {
        const answer = acceptedContent(
          call.extra.inputResponses,
          "deviceChoice",
          z.object({
            deviceId: z.string().refine((id) => candidates.some(({ deviceId }) => deviceId === id)),
          }),
        );
        return answer
          ? backend.execute({ ...call, args: { ...call.args, deviceId: answer.deviceId } })
          : result;
      }
      return inputRequired({
        inputRequests: {
          deviceChoice: inputRequired.elicit(deviceChoiceRequest(call.name, candidates)),
        },
      });
    },
  };
}
