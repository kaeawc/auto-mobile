import { describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "../../src/db/toolCallRepository";
import { ActionableError } from "../../src/models/ActionableError";
import { runRecordedToolCall } from "../../src/server/toolCallRecording";
import { FakeTimer } from "../fakes/FakeTimer";

describe("thrown tool call outcomes", () => {
  class MinifiedActionableError extends ActionableError {}
  Object.defineProperty(MinifiedActionableError, "name", { value: "_" });
  class NamedError extends Error {}

  test.each([
    {
      description: "minified actionable class",
      error: new MinifiedActionableError("missing"),
      expected: "ActionableError",
    },
    {
      description: "coded error",
      error: Object.assign(new Error("offline"), { code: "device_transport_unavailable" }),
      expected: "device_transport_unavailable",
    },
    { description: "plain Error", error: new Error("failure"), expected: "Error" },
    { description: "non-Error", error: "failure", expected: "UnknownError" },
    {
      description: "explicit error name",
      error: Object.assign(new NamedError("failure"), { name: "StableError" }),
      expected: "StableError",
    },
    {
      description: "short name with useful constructor",
      error: Object.assign(new NamedError("failure"), { name: "_", code: " " }),
      expected: "NamedError",
    },
    {
      description: "short name and minified constructor",
      error: Object.assign(new MinifiedActionableError("failure"), { name: "_" }),
      expected: "ActionableError",
    },
  ])("records $description", async ({ error, expected }) => {
    const records: ToolCallRecord[] = [];
    const repository = {
      async recordToolCall(record: ToolCallRecord) {
        records.push(record);
      },
    };

    await expect(
      runRecordedToolCall(repository, new FakeTimer(), "launchApp", {
        handler: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);

    expect(records).toEqual([expect.objectContaining({ status: "failure", errorType: expected })]);
  });
});
