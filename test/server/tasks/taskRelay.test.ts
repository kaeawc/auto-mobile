import { describe, expect, test } from "bun:test";
import { McpError } from "../../../src/daemon/mcpError";
import { missingTasksCapabilityError } from "../../../src/daemon/tasks/mcpTasksExtension";
import {
  parseTaskRelayFrame,
  relayedJsonRpcError,
  restoreCreateTaskResult,
  withCompleteResultType,
} from "../../../src/daemon/tasks/taskRelay";

/* The control-socket half of the Tasks relay (#4668): shapes the in-process SDK client lost. */

const TASK = {
  taskId: "task-1",
  status: "working",
  createdAt: "2026-10-18T00:00:00.000Z",
  lastUpdatedAt: "2026-10-18T00:00:00.000Z",
  ttlMs: null,
  pollIntervalMs: 1_000,
};

describe("task relay shapes (#4668)", () => {
  test("a task handle the SDK client decoded is restored to the wire shape the daemon sent", () => {
    const restored = restoreCreateTaskResult({ content: [], ...TASK });
    expect(JSON.stringify(restored)).toBe(JSON.stringify({ resultType: "task", ...TASK }));
  });

  test("an ordinary tool result is never taken for a task handle", () => {
    expect(restoreCreateTaskResult({ content: [{ type: "text", text: "x" }] })).toBeUndefined();
    expect(restoreCreateTaskResult({ content: [], isError: true, ...TASK })).toBeUndefined();
    expect(
      restoreCreateTaskResult({ content: [], structuredContent: {}, ...TASK }),
    ).toBeUndefined();
    expect(
      restoreCreateTaskResult({ content: [{ type: "text", text: "x" }], ...TASK }),
    ).toBeUndefined();
  });

  test("a tasks/* result gets back the resultType the client lifted, first", () => {
    expect(JSON.stringify(withCompleteResultType({ taskId: "t", status: "completed" }))).toBe(
      JSON.stringify({ resultType: "complete", taskId: "t", status: "completed" }),
    );
  });

  test("the daemon's JSON-RPC error loses only the loopback client's prefix", () => {
    const missing = missingTasksCapabilityError();
    expect(relayedJsonRpcError(new McpError(missing.code, missing.message, missing.data))).toEqual({
      code: -32021,
      message: "Missing required client capability",
      data: missing.data,
    });
    expect(relayedJsonRpcError(new Error("socket closed"))).toBeUndefined();
  });

  test("a frame's tasks field is used only when well-formed", () => {
    expect(parseTaskRelayFrame({ ownerKey: "proxy-tasks:1", declared: true })).toEqual({
      ownerKey: "proxy-tasks:1",
      declared: true,
    });
    expect(parseTaskRelayFrame({ ownerKey: " ", declared: true })).toBeUndefined();
    expect(parseTaskRelayFrame({ ownerKey: "k", declared: "yes" })).toBeUndefined();
    expect(parseTaskRelayFrame(undefined)).toBeUndefined();
  });
});
