import { expect, test } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY, type ElicitResult } from "@modelcontextprotocol/server";
import { withAmbiguousDeviceMrtr } from "../../src/server/ambiguousDeviceMrtr";
import {
  declaresFormElicitation,
  deviceChoiceRequest,
  withAmbiguousDeviceElicitation,
} from "../../src/server/ambiguousDeviceElicitation";
import type {
  McpToolCallExtra,
  ToolCall,
  ToolCallBackend,
  ToolCallRequest,
} from "../../src/server/toolCallDispatch";
import { FakeTimer } from "../fakes/FakeTimer";

const candidates = [
  { deviceId: "device-a", platform: "android" },
  { deviceId: "device-b", platform: "ios" },
];
const refusal = {
  isError: true,
  content: [
    { type: "text", text: JSON.stringify({ code: "ambiguous_device_target", candidates }) },
  ],
};
const success = { content: [{ type: "text", text: "done" }] };

class FakeBackend implements ToolCallBackend<ToolCallRequest, McpToolCallExtra, typeof success> {
  readonly progressFailureMessage = "unused";
  readonly calls: ToolCall<McpToolCallExtra>[] = [];
  result = refusal;
  retryResult = success;

  async execute(call: ToolCall<McpToolCallExtra>) {
    this.calls.push(call);
    return this.calls.length === 1 ? this.result : this.retryResult;
  }
}

interface Scenario {
  name: string;
  responses?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  args?: Record<string, unknown>;
  nonAmbiguous?: boolean;
  retry?: boolean;
  ask?: boolean;
  legacyAnswer?: ElicitResult;
}

const scenarios: Scenario[] = [
  { name: "no input", ask: true },
  {
    name: "accepted offered device",
    responses: { deviceChoice: { action: "accept", content: { deviceId: "device-b" } } },
    legacyAnswer: { action: "accept", content: { deviceId: "device-b" } },
    args: { value: "preserved" },
    retry: true,
  },
  {
    name: "accepted unknown device",
    responses: { deviceChoice: { action: "accept", content: { deviceId: "unknown" } } },
    legacyAnswer: { action: "accept", content: { deviceId: "unknown" } },
  },
  {
    name: "decline",
    responses: { deviceChoice: { action: "decline" } },
    legacyAnswer: { action: "decline" },
  },
  { name: "cancel", responses: { deviceChoice: { action: "cancel" } } },
  {
    name: "invalid accepted content",
    responses: { deviceChoice: { action: "accept", content: { deviceId: 1 } } },
  },
  { name: "invalid response", responses: { deviceChoice: { unexpected: true } } },
  { name: "empty retry", responses: {} },
  { name: "missing response key", responses: { other: { action: "accept" } } },
  { name: "no capability", capabilities: {} },
  {
    name: "accepted answer without capability",
    capabilities: {},
    responses: { deviceChoice: { action: "accept", content: { deviceId: "device-b" } } },
  },
  { name: "URL-only capability", capabilities: { elicitation: { url: {} } } },
  { name: "bare capability", capabilities: { elicitation: {} }, ask: true },
  { name: "deviceId already given", args: { deviceId: "device-a" } },
  { name: "non-ambiguous result", nonAmbiguous: true },
];

function makeCall(scenario: Scenario): ToolCall<McpToolCallExtra> {
  return {
    name: "probe",
    args: scenario.args ?? {},
    progress: undefined,
    progressToken: undefined,
    extra: {
      signal: new AbortController().signal,
      envelope: {
        [CLIENT_CAPABILITIES_META_KEY]: scenario.capabilities ?? { elicitation: { form: {} } },
      },
      ...(scenario.responses !== undefined && { inputResponses: scenario.responses }),
      sendNotification: async () => {},
    },
  };
}

for (const scenario of scenarios) {
  test(`modern device choice: ${scenario.name}`, async () => {
    const backend = new FakeBackend();
    if (scenario.nonAmbiguous) {
      backend.result = { ...success, isError: false };
    }
    const call = makeCall(scenario);
    const result = await withAmbiguousDeviceMrtr(backend).execute(call);

    if (scenario.ask) {
      expect(result).toEqual({
        resultType: "input_required",
        inputRequests: {
          deviceChoice: {
            method: "elicitation/create",
            params: deviceChoiceRequest("probe", candidates),
          },
        },
      });
    } else {
      expect(result).toBe(scenario.retry ? success : backend.result);
    }
    expect(backend.calls).toHaveLength(scenario.retry ? 2 : 1);
    if (scenario.retry) {
      expect(backend.calls[1]).toEqual({ ...call, args: { ...call.args, deviceId: "device-b" } });
    }
    expect(call.args.deviceId).toBe(scenario.args?.deviceId);
  });

  test(`legacy wrapper unchanged: ${scenario.name}`, async () => {
    const backend = new FakeBackend();
    if (scenario.nonAmbiguous) {
      backend.result = { ...success, isError: false };
    }
    let questions = 0;
    const call = makeCall(scenario);
    const declaresElicitation = declaresFormElicitation(
      scenario.capabilities ?? { elicitation: { form: {} } },
    );
    const result = await withAmbiguousDeviceElicitation(
      backend,
      {
        declaresElicitation: () => declaresElicitation,
        elicit: async () => {
          questions++;
          return scenario.legacyAnswer ?? { action: "cancel" };
        },
      },
      { timer: new FakeTimer() },
    ).execute(call);

    expect(result).toBe(scenario.retry ? success : backend.result);
    expect(backend.calls).toHaveLength(scenario.retry ? 2 : 1);
    expect(questions).toBe(
      declaresElicitation && call.args.deviceId === undefined && !scenario.nonAmbiguous ? 1 : 0,
    );
  });
}

test("modern wrapper leaves an envelope-free request untouched", async () => {
  const backend = new FakeBackend();
  const call = makeCall({ name: "legacy" });
  const result = await withAmbiguousDeviceMrtr(backend).execute({
    ...call,
    extra: { ...call.extra, envelope: undefined },
  });
  expect(result).toBe(refusal);
  expect(backend.calls).toHaveLength(1);
});

test("a selected-device retry that remains ambiguous never asks again", async () => {
  const backend = new FakeBackend();
  backend.retryResult = refusal;
  const call = makeCall(scenarios[1]);
  expect(await withAmbiguousDeviceMrtr(backend).execute(call)).toBe(refusal);
  expect(backend.calls).toHaveLength(2);
});
