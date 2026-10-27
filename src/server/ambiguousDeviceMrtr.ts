import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { stableStringify } from "../utils/stableStringify";
import { deviceChoiceRequestStateSchema } from "./deviceChoiceRequestState";
import { ambiguousDeviceCandidates, declaresFormElicitation } from "./ambiguousDeviceElicitation";
import {
  classifyElicitationDeclaration,
  telemetryElicitationRecorder,
  type ElicitationRecorder,
} from "./elicitationOutcome";
import { executeWithDeviceChoice } from "./ambiguousDeviceChoice";
import { defaultTimer } from "../utils/SystemTimer";
import type {
  McpToolCallExtra,
  ToolCall,
  ToolCallBackend,
  ToolCallRequest,
} from "./toolCallDispatch";

/** Modern requests ask in-band; only the signing key survives the HTTP exchange. */
export function withAmbiguousDeviceMrtr<Req extends ToolCallRequest, Result>(
  backend: ToolCallBackend<Req, McpToolCallExtra, Result>,
  recorder: ElicitationRecorder = telemetryElicitationRecorder,
): ToolCallBackend<Req, McpToolCallExtra, Result | InputRequiredResult> {
  return {
    ...backend,
    execute: async (call) => {
      if (
        call.args.deviceId !== undefined ||
        !declaresFormElicitation(call.extra.envelope?.[CLIENT_CAPABILITIES_META_KEY])
      ) {
        const result = await backend.execute(call);
        const candidates = call.args.deviceId === undefined && ambiguousDeviceCandidates(result);
        if (candidates) {
          recordNotOffered(recorder, call, candidates.length);
        }
        return result;
      }
      const argumentsWithoutDevice = { ...call.args };
      delete argumentsWithoutDevice.deviceId;
      const argumentsHash = createHash("sha256")
        .update(stableStringify(argumentsWithoutDevice))
        .digest("hex");
      return executeWithDeviceChoice<McpToolCallExtra, Result, InputRequiredResult>(
        call,
        (retry) => backend.execute(retry),
        async ({ candidates, inputRequests }) => {
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
              return undefined;
            }
            return { responses: call.extra.inputResponses, offeredDeviceIds: state.data.deviceIds };
          }
          if (!call.extra.deviceChoiceState) {
            return undefined;
          }
          return {
            pending: inputRequired({
              requestState: await call.extra.deviceChoiceState.mint({
                version: 1,
                toolName: call.name,
                argumentsHash,
                deviceIds: candidates.map(({ deviceId }) => deviceId),
              }),
              inputRequests,
            }),
          };
        },
        {
          recorder,
          declared: classifyElicitationDeclaration(
            call.extra.envelope?.[CLIENT_CAPABILITIES_META_KEY],
          ),
        },
      );
    },
  };
}

function recordNotOffered(
  recorder: ElicitationRecorder,
  call: ToolCall<McpToolCallExtra>,
  candidateCount: number,
): void {
  recorder.record({
    toolName: call.name,
    era: "modern",
    declared: classifyElicitationDeclaration(call.extra.envelope?.[CLIENT_CAPABILITIES_META_KEY]),
    outcome: "not_offered",
    candidateCount,
    atMs: defaultTimer.now(),
  });
}
