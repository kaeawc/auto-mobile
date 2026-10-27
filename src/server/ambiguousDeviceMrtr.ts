import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createHash } from "node:crypto";
import { stableStringify } from "../utils/stableStringify";
import { deviceChoiceRequestStateSchema } from "./deviceChoiceRequestState";
import {
  ambiguousDeviceCandidates,
  declaresFormElicitation,
  deviceChoiceRequest,
} from "./ambiguousDeviceElicitation";
import type { McpToolCallExtra, ToolCallBackend, ToolCallRequest } from "./toolCallDispatch";

/** Modern requests ask in-band; only the signing key survives the HTTP exchange. */
export function withAmbiguousDeviceMrtr<Req extends ToolCallRequest, Result>(
  backend: ToolCallBackend<Req, McpToolCallExtra, Result>,
): ToolCallBackend<Req, McpToolCallExtra, Result | InputRequiredResult> {
  return {
    ...backend,
    execute: async (call) => {
      if (
        call.args.deviceId !== undefined ||
        !declaresFormElicitation(call.extra.envelope?.[CLIENT_CAPABILITIES_META_KEY])
      ) {
        return backend.execute(call);
      }
      const argumentsWithoutDevice = { ...call.args };
      delete argumentsWithoutDevice.deviceId;
      const argumentsHash = createHash("sha256")
        .update(stableStringify(argumentsWithoutDevice))
        .digest("hex");
      const result = await backend.execute(call);
      const candidates = ambiguousDeviceCandidates(result);
      if (!candidates) {
        return result;
      }
      // Any retry response map ends the question flow, including empty or malformed answers.
      if (call.extra.inputResponses !== undefined) {
        const state = deviceChoiceRequestStateSchema.safeParse(
          call.extra.deviceChoiceState?.verified,
        );
        if (
          !state.success ||
          state.data.toolName !== call.name ||
          state.data.argumentsHash !== argumentsHash
        ) {
          return result;
        }
        const answer = acceptedContent(
          call.extra.inputResponses,
          "deviceChoice",
          z.object({
            deviceId: z
              .string()
              .refine(
                (id) =>
                  state.data.deviceIds.includes(id) &&
                  candidates.some(({ deviceId }) => deviceId === id),
              ),
          }),
        );
        return answer
          ? backend.execute({ ...call, args: { ...call.args, deviceId: answer.deviceId } })
          : result;
      }
      if (!call.extra.deviceChoiceState) {
        return result;
      }
      return inputRequired({
        requestState: await call.extra.deviceChoiceState.mint({
          version: 1,
          toolName: call.name,
          argumentsHash,
          deviceIds: candidates.map(({ deviceId }) => deviceId),
        }),
        inputRequests: {
          deviceChoice: inputRequired.elicit(deviceChoiceRequest(call.name, candidates)),
        },
      });
    },
  };
}
