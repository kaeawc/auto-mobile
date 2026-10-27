import { describe, expect, test } from "bun:test";
import {
  conformanceProblems,
  observeElicitation,
  PUSHED_REQUEST_ID,
  type StubLogLine,
} from "../../scripts/conformance/claude-elicitation/observation";

const KEY = "io.example/clientCapabilities";

const initialize: StubLogLine = {
  in: {
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { elicitation: {} },
      clientInfo: { name: "claude-code", version: "2.1.220" },
    },
  },
};
const call: StubLogLine = { in: { method: "tools/call", params: { name: "pick", _meta: {} } } };

describe("observeElicitation", () => {
  test("a legacy push answered with cancel conforms", () => {
    const observation = observeElicitation(
      [
        initialize,
        call,
        { note: "pushed" },
        { in: { id: PUSHED_REQUEST_ID, result: { action: "cancel" } } },
      ],
      KEY,
    );
    expect(observation).toMatchObject({
      clientName: "claude-code",
      protocolVersion: "2025-11-25",
      declared: {},
      eraTaken: "legacy_push",
      answerAction: "cancel",
      toolCalled: true,
    });
    expect(conformanceProblems(observation)).toEqual([]);
  });

  test("a modern input_required retry is read from its input responses", () => {
    const observation = observeElicitation(
      [
        initialize,
        call,
        { note: "input_required" },
        {
          in: {
            method: "tools/call",
            params: { inputResponses: { device: { action: "decline" } } },
          },
        },
      ],
      KEY,
    );
    expect(observation.eraTaken).toBe("modern_input_required");
    expect(observation.answerAction).toBe("decline");
  });

  test("a client that never calls the tool or answers does not conform", () => {
    expect(conformanceProblems(observeElicitation([initialize], KEY))).toEqual([
      "the client never called the stub tool",
      "the stub could not ask the question: the client declared no elicitation",
    ]);
    expect(
      conformanceProblems(observeElicitation([initialize, call, { note: "pushed" }], KEY)),
    ).toEqual(["the client did not answer the question"]);
  });
});
