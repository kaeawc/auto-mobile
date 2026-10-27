import { describe, expect, test } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { withAmbiguousDeviceMrtr } from "../../src/server/ambiguousDeviceMrtr";
import {
  withAmbiguousDeviceElicitation,
  type DeviceChoicePeer,
} from "../../src/server/ambiguousDeviceElicitation";
import type { ElicitationRecord, ElicitationRecorder } from "../../src/server/elicitationOutcome";
import { DeclineMemory, elicitationEnabled } from "../../src/server/elicitationPolicy";
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

class RefusingBackend implements ToolCallBackend<
  ToolCallRequest,
  McpToolCallExtra,
  typeof success | typeof refusal
> {
  readonly progressFailureMessage = "unused";
  async execute(call: ToolCall<McpToolCallExtra>) {
    return call.args.deviceId === undefined ? refusal : success;
  }
}

const callWith = (
  args: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = { elicitation: { form: {} } },
): ToolCall<McpToolCallExtra> => ({
  name: "probe",
  args,
  progress: undefined,
  progressToken: undefined,
  extra: {
    signal: new AbortController().signal,
    sendNotification: async () => {},
    envelope: { [CLIENT_CAPABILITIES_META_KEY]: capabilities },
  },
});

describe("elicitationEnabled", () => {
  test("is on unless AUTOMOBILE_ELICITATION is off", () => {
    expect(elicitationEnabled({})).toBe(true);
    expect(elicitationEnabled({ AUTOMOBILE_ELICITATION: "on" })).toBe(true);
    expect(elicitationEnabled({ AUTOMOBILE_ELICITATION: "off" })).toBe(false);
    expect(elicitationEnabled({ AUTOMOBILE_ELICITATION: " OFF " })).toBe(false);
    expect(elicitationEnabled({ AUTOMOBILE_ELICITATION: "nonsense" })).toBe(true);
  });
});

describe("DeclineMemory", () => {
  test("keys on the candidate set, ignoring order and duplicates", () => {
    const memory = new DeclineMemory();
    expect(memory.remembers(["a", "b"])).toBe(false);
    memory.remember(["b", "a", "a"]);
    expect(memory.remembers(["a", "b"])).toBe(true);
    expect(memory.remembers(["a", "b", "c"])).toBe(false);
    expect(memory.remembers(["a"])).toBe(false);
  });
});

describe("legacy ask policy (#15590)", () => {
  function setup(options: { enabled?: boolean; answers: Array<"decline" | "cancel" | "accept"> }) {
    const recorder = new FakeRecorder();
    const declines = new DeclineMemory();
    let asked = 0;
    const answers = [...options.answers];
    const peer: DeviceChoicePeer = {
      declaresElicitation: () => true,
      declaration: () => "form",
      elicit: async () => {
        asked++;
        const action = answers.shift() ?? "cancel";
        return action === "accept" ? { action, content: { deviceId: "device-b" } } : { action };
      },
    };
    const backend = withAmbiguousDeviceElicitation(new RefusingBackend(), peer, {
      timer: new FakeTimer(),
      recorder,
      declines,
      enabled: () => options.enabled ?? true,
    });
    return { backend, recorder, declines, asked: () => asked };
  }

  test("off never asks and records disabled", async () => {
    const { backend, recorder, asked } = setup({ enabled: false, answers: ["accept"] });
    expect(await backend.execute(callWith())).toBe(refusal);
    expect(asked()).toBe(0);
    expect(recorder.records).toMatchObject([{ outcome: "disabled", declared: "form" }]);
  });

  test.each(["decline", "cancel"] as const)(
    "a %s is not asked again for the same candidates on this connection",
    async (action) => {
      const { backend, recorder, asked } = setup({ answers: [action, "accept"] });
      expect(await backend.execute(callWith())).toBe(refusal);
      expect(await backend.execute(callWith())).toBe(refusal);
      expect(asked()).toBe(1);
      expect(recorder.records.map((record) => record.outcome)).toEqual([action, "remembered"]);
    },
  );

  test("an accepted answer is not remembered, so the next ambiguity asks again", async () => {
    const { backend, asked } = setup({ answers: ["accept", "accept"] });
    expect(await backend.execute(callWith())).toBe(success);
    expect(await backend.execute(callWith())).toBe(success);
    expect(asked()).toBe(2);
  });

  test("a changed candidate set is a new question", async () => {
    const { declines, backend, asked } = setup({ answers: ["decline", "decline"] });
    declines.remember(["other-a", "other-b"]);
    await backend.execute(callWith());
    expect(asked()).toBe(1);
  });

  test("a separate connection's memory does not carry over", async () => {
    const first = setup({ answers: ["decline"] });
    const second = setup({ answers: ["decline"] });
    await first.backend.execute(callWith());
    await second.backend.execute(callWith());
    expect(first.asked()).toBe(1);
    expect(second.asked()).toBe(1);
  });
});

describe("modern ask policy (#15590)", () => {
  test("off returns the refusal without a question and records disabled", async () => {
    const recorder = new FakeRecorder();
    const result = await withAmbiguousDeviceMrtr(
      new RefusingBackend(),
      recorder,
      () => false,
    ).execute(callWith());
    expect(result).toBe(refusal);
    expect(recorder.records).toMatchObject([{ era: "modern", outcome: "disabled" }]);
  });
});
