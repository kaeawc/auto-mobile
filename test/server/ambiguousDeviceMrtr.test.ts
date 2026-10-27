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
import { createHash } from "node:crypto";
import { stableStringify } from "../../src/utils/stableStringify";
import {
  createDeviceChoiceRequestStateCodec,
  type DeviceChoiceRequestState,
  type DeviceChoiceRequestStateCodec,
} from "../../src/server/deviceChoiceRequestState";
import { MCP_SESSION_KEY_HEADER } from "../../src/daemon/mcpSessionKey";
import { fakeServerContext } from "../helpers/fakeServerContext";

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
      deviceChoiceState: {
        verified: {
          version: 1,
          toolName: "probe",
          argumentsHash: createHash("sha256")
            .update(stableStringify(scenario.args ?? {}))
            .digest("hex"),
          deviceIds: candidates.map(({ deviceId }) => deviceId),
        },
        mint: async () => "fake-sealed-state",
      },
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
        requestState: "fake-sealed-state",
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

function sessionContext(sessionKey: string | undefined) {
  return {
    ...fakeServerContext(),
    http: {
      req: new Request("http://localhost/mcp", {
        headers: sessionKey === undefined ? {} : { [MCP_SESSION_KEY_HEADER]: sessionKey },
      }),
    },
  };
}

function withState(
  call: ToolCall<McpToolCallExtra>,
  codec: DeviceChoiceRequestStateCodec,
  ctx: ReturnType<typeof sessionContext>,
  verified?: unknown,
): ToolCall<McpToolCallExtra> {
  return {
    ...call,
    extra: {
      ...call.extra,
      deviceChoiceState: { verified, mint: (payload) => codec.mint(payload, ctx) },
    },
  };
}

interface BindingScenario {
  name: string;
  outcome: "accept" | "refuse" | "invalid";
  toolName?: string;
  args?: Record<string, unknown>;
  sessionKey?: string;
  noSession?: boolean;
  advanceMs?: number;
  tamper?: boolean;
  noState?: boolean;
  currentDeviceIds?: string[];
  answerId?: string;
}

const bindingScenarios: BindingScenario[] = [
  { name: "valid bound answer", outcome: "accept" },
  { name: "different tool", toolName: "other", outcome: "refuse" },
  { name: "different args", args: { value: "changed" }, outcome: "refuse" },
  { name: "different session key", sessionKey: "other", outcome: "invalid" },
  { name: "missing session key", noSession: true, outcome: "invalid" },
  { name: "expired at ten minutes", advanceMs: 600_000, outcome: "invalid" },
  { name: "valid just before expiry", advanceMs: 599_999, outcome: "accept" },
  { name: "tampered state", tamper: true, outcome: "invalid" },
  {
    name: "offered id no longer a candidate",
    currentDeviceIds: ["device-a", "device-c"],
    outcome: "refuse",
  },
  {
    name: "new candidate was not offered",
    currentDeviceIds: ["device-a", "device-b", "device-c"],
    answerId: "device-c",
    outcome: "refuse",
  },
  { name: "no state", noState: true, outcome: "refuse" },
  {
    name: "nested key order is canonical",
    args: { nested: { a: 1, z: [2, 3] }, value: "same" },
    outcome: "accept",
  },
  {
    name: "array order is significant",
    args: { value: "same", nested: { z: [3, 2], a: 1 } },
    outcome: "refuse",
  },
  {
    name: "nested deviceId is significant",
    args: { value: "same", nested: { z: [2, 3], a: 1, deviceId: "other" } },
    outcome: "refuse",
  },
];

for (const scenario of bindingScenarios) {
  test(`modern request state: ${scenario.name}`, async () => {
    const timer = new FakeTimer();
    const codec = createDeviceChoiceRequestStateCodec({
      timer,
      secretProvider: { createSecret: () => new Uint8Array(32).fill(7) },
    });
    const ctx = sessionContext("origin");
    const args = { value: "same", nested: { z: [2, 3], a: 1 } };
    const initial = withState(makeCall({ name: "initial", args }), codec, ctx);
    const question = await withAmbiguousDeviceMrtr(new FakeBackend()).execute(initial);
    if (!("requestState" in question) || typeof question.requestState !== "string") {
      throw new Error("Expected sealed device question");
    }
    const retryCtx = sessionContext(
      scenario.noSession ? undefined : (scenario.sessionKey ?? "origin"),
    );
    timer.advanceTime(scenario.advanceMs ?? 0);
    const wireState = scenario.tamper ? `${question.requestState}tampered` : question.requestState;
    if (scenario.outcome === "invalid") {
      await expect(codec.verify(wireState, retryCtx)).rejects.toThrow();
      return;
    }
    const verified = scenario.noState ? undefined : await codec.verify(wireState, retryCtx);
    const backend = new FakeBackend();
    if (scenario.currentDeviceIds) {
      backend.result = {
        ...refusal,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "ambiguous_device_target",
              candidates: scenario.currentDeviceIds.map((deviceId) => ({
                deviceId,
                platform: "android",
              })),
            }),
          },
        ],
      };
    }
    const retry = withState(
      {
        ...makeCall({
          name: "retry",
          args: scenario.args ?? args,
          responses: {
            deviceChoice: {
              action: "accept",
              content: { deviceId: scenario.answerId ?? "device-b" },
            },
          },
        }),
        name: scenario.toolName ?? "probe",
      },
      codec,
      retryCtx,
      verified,
    );
    const result = await withAmbiguousDeviceMrtr(backend).execute(retry);
    expect(result).toBe(scenario.outcome === "accept" ? success : backend.result);
    expect(backend.calls).toHaveLength(scenario.outcome === "accept" ? 2 : 1);
  });
}

test("request state secret is lazy and shared across rounds", async () => {
  let secretsCreated = 0;
  const codec = createDeviceChoiceRequestStateCodec({
    timer: new FakeTimer(),
    secretProvider: {
      createSecret: () => {
        secretsCreated++;
        return new Uint8Array(32).fill(9);
      },
    },
  });
  expect(secretsCreated).toBe(0);
  const ctx = sessionContext("origin");
  const payload = {
    version: 1,
    toolName: "probe",
    argumentsHash: "hash",
    deviceIds: ["a", "b"],
  } satisfies DeviceChoiceRequestState;
  const state = await codec.mint(payload, ctx);
  expect(await codec.verify(state, sessionContext("origin"))).toEqual(payload);
  await codec.mint(payload, ctx);
  expect(secretsCreated).toBe(1);
});

test("state with no session header retains the unkeyed binding and fails under a key", async () => {
  const codec = createDeviceChoiceRequestStateCodec({
    timer: new FakeTimer(),
    secretProvider: { createSecret: () => new Uint8Array(32).fill(7) },
  });
  const payload = {
    version: 1,
    toolName: "probe",
    argumentsHash: "hash",
    deviceIds: ["a", "b"],
  } satisfies DeviceChoiceRequestState;
  const state = await codec.mint(payload, sessionContext(undefined));
  expect(await codec.verify(state, sessionContext(undefined))).toEqual(payload);
  await expect(codec.verify(state, sessionContext("keyed"))).rejects.toThrow("bind");
});

test("a new process secret invalidates an outstanding question", async () => {
  const makeCodec = (byte: number) =>
    createDeviceChoiceRequestStateCodec({
      timer: new FakeTimer(),
      secretProvider: { createSecret: () => new Uint8Array(32).fill(byte) },
    });
  const ctx = sessionContext("origin");
  const state = await makeCodec(7).mint(
    { version: 1, toolName: "probe", argumentsHash: "hash", deviceIds: ["a", "b"] },
    ctx,
  );
  await expect(makeCodec(8).verify(state, ctx)).rejects.toThrow("mac");
});

test("the argument hash captures the originating arguments before backend mutation", async () => {
  const call = makeCall({ name: "initial", args: { value: "original", deviceId: undefined } });
  let sealed: DeviceChoiceRequestState | undefined;
  const result = await withAmbiguousDeviceMrtr({
    progressFailureMessage: "unused",
    execute: async (received: ToolCall<McpToolCallExtra>) => {
      received.args.value = "changed";
      return refusal;
    },
  }).execute({
    ...call,
    extra: {
      ...call.extra,
      deviceChoiceState: {
        verified: undefined,
        mint: async (payload) => {
          sealed = payload;
          return "sealed";
        },
      },
    },
  });
  expect(result).toHaveProperty("requestState", "sealed");
  expect(sealed?.argumentsHash).toBe(
    createHash("sha256")
      .update(stableStringify({ value: "original" }))
      .digest("hex"),
  );
});

for (const verified of [
  "raw-wire-state",
  {},
  { version: 2, toolName: "probe", argumentsHash: "hash", deviceIds: ["device-b"] },
]) {
  test("unrecognized verified state returns the original refusal", async () => {
    const backend = new FakeBackend();
    const call = makeCall(scenarios[1]);
    const result = await withAmbiguousDeviceMrtr(backend).execute({
      ...call,
      extra: { ...call.extra, deviceChoiceState: { verified, mint: async () => "unused" } },
    });
    expect(result).toBe(refusal);
    expect(backend.calls).toHaveLength(1);
  });
}
