import { describe, expect, test } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY, type ElicitResult } from "@modelcontextprotocol/server";
import { withAmbiguousDeviceMrtr } from "../../src/server/ambiguousDeviceMrtr";
import {
  withAmbiguousDeviceElicitation,
  type DeviceChoicePeer,
} from "../../src/server/ambiguousDeviceElicitation";
import {
  classifyElicitationDeclaration,
  createTelemetryElicitationRecorder,
  type ElicitationRecord,
  type ElicitationRecorder,
} from "../../src/server/elicitationOutcome";
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

class FakeRecorder implements ElicitationRecorder {
  readonly records: ElicitationRecord[] = [];
  record(record: ElicitationRecord): void {
    this.records.push(record);
  }
}

type Outcome = typeof success | typeof refusal;

class FakeBackend implements ToolCallBackend<ToolCallRequest, McpToolCallExtra, Outcome> {
  readonly progressFailureMessage = "unused";
  calls = 0;
  result: Outcome = success;
  async execute(call: ToolCall<McpToolCallExtra>) {
    this.calls++;
    return call.args.deviceId === undefined ? this.result : success;
  }
}

function makeCall(
  args: Record<string, unknown> = {},
  extra: Partial<McpToolCallExtra> = {},
  signal = new AbortController().signal,
): ToolCall<McpToolCallExtra> {
  return {
    name: "probe",
    args,
    progress: undefined,
    progressToken: undefined,
    extra: { signal, sendNotification: async () => {}, ...extra },
  };
}

describe("classifyElicitationDeclaration", () => {
  test("separates none, bare, form and url", () => {
    expect(classifyElicitationDeclaration(undefined)).toBe("none");
    expect(classifyElicitationDeclaration({})).toBe("none");
    expect(classifyElicitationDeclaration({ elicitation: {} })).toBe("bare");
    expect(classifyElicitationDeclaration({ elicitation: { form: {} } })).toBe("form");
    expect(classifyElicitationDeclaration({ elicitation: { url: {} } })).toBe("url");
    expect(classifyElicitationDeclaration({ elicitation: { form: {}, url: {} } })).toBe("form");
  });
});

describe("legacy ask recording (#15588)", () => {
  const ambiguous = () => {
    const backend = new FakeBackend();
    backend.result = refusal;
    return backend;
  };
  function run(
    peer: Partial<DeviceChoicePeer> & { answer?: ElicitResult | Error | "never" },
    callSignal?: AbortController,
  ) {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    const fullPeer: DeviceChoicePeer = {
      declaresElicitation: () => true,
      declaration: () => "form",
      elicit: async (_params, signal) => {
        timer.advanceTime(7);
        const answer = peer.answer;
        if (answer === "never") {
          return new Promise<ElicitResult>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        }
        if (answer instanceof Error) {
          throw answer;
        }
        return answer ?? { action: "cancel" };
      },
      ...peer,
    };
    const backend = withAmbiguousDeviceElicitation(ambiguous(), fullPeer, { timer, recorder });
    const result = backend.execute(makeCall({}, {}, callSignal?.signal));
    return { timer, recorder, result };
  }

  test("records an accepted choice with its latency", async () => {
    const { recorder, result } = run({
      answer: { action: "accept", content: { deviceId: "device-b" } },
    });
    expect(await result).toBe(success);
    expect(recorder.records).toEqual([
      {
        toolName: "probe",
        era: "legacy",
        declared: "form",
        outcome: "accept",
        candidateCount: 2,
        atMs: expect.any(Number),
        latencyMs: 7,
      },
    ]);
  });

  test.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
    ["invalid", { action: "accept", content: { deviceId: "not-offered" } }],
  ] as const)("records %s", async (outcome, answer) => {
    const { recorder, result } = run({ answer });
    expect(await result).toBe(refusal);
    expect(recorder.records.map((record) => record.outcome)).toEqual([outcome]);
  });

  test("records a failed ask as error", async () => {
    const { recorder, result } = run({ answer: new Error("transport closed") });
    await result;
    expect(recorder.records.map((record) => record.outcome)).toEqual(["error"]);
  });

  test("records timeout when nobody answers within the bound", async () => {
    const { timer, recorder, result } = run({ answer: "never" });
    await Promise.resolve();
    timer.advanceTime(20_000);
    expect(await result).toBe(refusal);
    expect(recorder.records.map((record) => record.outcome)).toEqual(["timeout"]);
  });

  test("records cancel when the call itself is cancelled", async () => {
    const controller = new AbortController();
    const { recorder, result } = run({ answer: "never" }, controller);
    await Promise.resolve();
    controller.abort();
    await result;
    expect(recorder.records.map((record) => record.outcome)).toEqual(["cancel"]);
  });

  test.each([
    ["none", false],
    ["url", false],
  ] as const)("records not_offered for a %s declaration without asking", async (declared) => {
    let asked = false;
    const { recorder, result } = run({
      declaresElicitation: () => false,
      declaration: () => declared,
      elicit: async () => {
        asked = true;
        return { action: "cancel" };
      },
    });
    expect(await result).toBe(refusal);
    expect(asked).toBe(false);
    expect(recorder.records).toMatchObject([{ declared, outcome: "not_offered" }]);
    expect(recorder.records[0]?.latencyMs).toBeUndefined();
  });

  test("derives the declaration for a peer that omits it", async () => {
    const { recorder, result } = run({ declaration: undefined, declaresElicitation: () => false });
    await result;
    expect(recorder.records).toMatchObject([{ declared: "none", outcome: "not_offered" }]);
  });

  test("records nothing for a call that already names a device or is not ambiguous", async () => {
    const recorder = new FakeRecorder();
    const peer: DeviceChoicePeer = {
      declaresElicitation: () => true,
      elicit: async () => ({ action: "cancel" }),
    };
    const named = withAmbiguousDeviceElicitation(new FakeBackend(), peer, { recorder });
    await named.execute(makeCall({ deviceId: "x" }));
    await named.execute(makeCall({}));
    expect(recorder.records).toEqual([]);
  });
});

describe("modern ask recording (#15588)", () => {
  function modernCall(
    capabilities: Record<string, unknown>,
    responses?: Record<string, unknown>,
  ): ToolCall<McpToolCallExtra> {
    return makeCall(
      {},
      {
        envelope: { [CLIENT_CAPABILITIES_META_KEY]: capabilities },
        ...(responses !== undefined && { inputResponses: responses }),
        deviceChoiceState: {
          verified: {
            version: 1,
            toolName: "probe",
            // SHA-256 of the canonical empty arguments object.
            argumentsHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            deviceIds: candidates.map(({ deviceId }) => deviceId),
          },
          mint: async () => "sealed",
        },
      },
    );
  }
  const refusingBackend = () => {
    const backend = new FakeBackend();
    backend.result = refusal;
    return backend;
  };

  test("records asked when the question is handed back", async () => {
    const recorder = new FakeRecorder();
    await withAmbiguousDeviceMrtr(refusingBackend(), recorder).execute(
      modernCall({ elicitation: { form: {} } }),
    );
    expect(recorder.records).toMatchObject([
      { era: "modern", declared: "form", outcome: "asked", candidateCount: 2 },
    ]);
    expect(recorder.records[0]?.latencyMs).toBeUndefined();
  });

  test.each([
    ["accept", { deviceChoice: { action: "accept", content: { deviceId: "device-b" } } }],
    ["decline", { deviceChoice: { action: "decline" } }],
    ["cancel", { deviceChoice: { action: "cancel" } }],
    ["invalid", { deviceChoice: { action: "accept", content: { deviceId: 1 } } }],
    ["invalid", { other: {} }],
  ] as const)("records the answer %s", async (outcome, responses) => {
    const recorder = new FakeRecorder();
    await withAmbiguousDeviceMrtr(refusingBackend(), recorder).execute(
      modernCall({ elicitation: { form: {} } }, responses),
    );
    expect(recorder.records.map((record) => record.outcome)).toEqual([outcome]);
  });

  test("records not_offered for a client that declared nothing", async () => {
    const recorder = new FakeRecorder();
    await withAmbiguousDeviceMrtr(refusingBackend(), recorder).execute(modernCall({}));
    expect(recorder.records).toMatchObject([
      { era: "modern", declared: "none", outcome: "not_offered" },
    ]);
  });
});

describe("telemetry recorder", () => {
  test("pushes the record to the sink it was given", () => {
    const pushed: unknown[] = [];
    const recorder = createTelemetryElicitationRecorder({
      recordElicitationEvent: (event) => void pushed.push(event),
    });
    const record: ElicitationRecord = {
      toolName: "probe",
      era: "legacy",
      declared: "form",
      outcome: "accept",
      candidateCount: 2,
      atMs: 5,
      latencyMs: 3,
    };
    recorder.record(record);
    expect(pushed).toEqual([record]);
  });
});
