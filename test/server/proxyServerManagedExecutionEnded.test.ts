import { beforeAll, expect, spyOn, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import type { ManagedSlotsResult } from "../../src/models/managedSlotsResult";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
} from "../../src/daemon/daemonMcpProxy";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

const SESSION = "11111111-2222-4333-8444-555555555555";

function createHarness(managedSlots?: ManagedSlotsResult) {
  const registration = spyOn(Server.prototype, "setRequestHandler");
  const harness = createProxyMcpServer({
    managedSlots,
    proxyConfig: {
      timer: new FakeTimer(),
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: new FakeDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
    },
  });
  const registrations = [...registration.mock.calls];
  registration.mockRestore();
  return { ...harness, registrations };
}

const extra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: async () => {},
  sendRequest: async () => {
    throw new Error("Unexpected request");
  },
};

beforeAll(async () => {
  // Warm the SDK's one-off handler/schema initialization with a disposable server.
  const { server, proxy } = createHarness();
  try {
    await server.close();
  } finally {
    await proxy.close();
  }
});

/** Run one `tools/call` against a proxy whose daemon call is replaced by `outcome`. */
async function callThrough(
  managedSlots: ManagedSlotsResult | undefined,
  outcome: { throws: unknown } | { returns: CallToolResult },
): Promise<{ isError?: boolean; error?: Record<string, unknown>; text: string }> {
  const { server, proxy, registrations } = createHarness(managedSlots);
  const call = spyOn(proxy, "callTool");
  if ("throws" in outcome) {
    call.mockRejectedValue(outcome.throws);
  } else {
    call.mockResolvedValue(outcome.returns);
  }
  try {
    const handler = registrations.find(([schema]) => schema === CallToolRequestSchema)?.[1];
    if (!handler) {
      throw new Error("Missing handler");
    }
    const result = await handler({ method: "tools/call", params: { name: "tapOn" } }, extra);
    const text = (result.content[0] as { text: string }).text;
    return { isError: result.isError, error: JSON.parse(text).error, text };
  } finally {
    call.mockRestore();
    await server.close();
    await proxy.close();
  }
}

test("a managed connection answers a released slot session with managed_execution_ended", async () => {
  const { error } = await callThrough(readyManagedSlotsResult(SESSION), {
    throws: new DaemonBoundSessionExpiredError(SESSION, "heartbeat_timeout"),
  });
  expect(error).toMatchObject({
    code: "managed_execution_ended",
    retryable: false,
    nextAction: "relaunch_execution",
    sessionUuid: SESSION,
    reason: "heartbeat_timeout",
    slotIndex: 1,
    assignmentGeneration: 3,
  });
  expect(error).not.toHaveProperty("recovery");
});

test("the managed refusal never points the agent at getAndroid or getApple", async () => {
  const { text } = await callThrough(readyManagedSlotsResult(SESSION), {
    throws: new DaemonBoundSessionExpiredError(SESSION, "idle_timeout"),
  });
  expect(text).not.toContain("getAndroid");
  expect(text).not.toContain("getApple");
  expect(text).not.toContain("acquire_new_session");
});

test("a managed connection's session-less release is managed_execution_ended too", async () => {
  const { error } = await callThrough(readyManagedSlotsResult(SESSION), {
    throws: new DaemonConnectionSessionReleasedError("heartbeat_timeout"),
  });
  expect(error).toMatchObject({
    code: "managed_execution_ended",
    nextAction: "relaunch_execution",
    reason: "heartbeat_timeout",
  });
  expect(error).not.toHaveProperty("slotIndex");
});

test("a daemon session_ownership_lost relayed to a managed connection is rewritten", async () => {
  const relayed = sessionOwnershipLostPayload({
    message: "Session ownership lost.",
    sessionUuid: SESSION,
    reason: "owner-exit",
  });
  const { isError, error } = await callThrough(readyManagedSlotsResult(SESSION), {
    returns: { isError: true, content: [{ type: "text", text: JSON.stringify(relayed) }] },
  });
  expect(isError).toBe(true);
  expect(error).toMatchObject({
    code: "managed_execution_ended",
    nextAction: "relaunch_execution",
    reason: "owner-exit",
    slotIndex: 1,
  });
});

test("a non-managed connection keeps the acquire-new-session refusal", async () => {
  const { error } = await callThrough(undefined, {
    throws: new DaemonBoundSessionExpiredError(SESSION, "heartbeat_timeout"),
  });
  expect(error).toMatchObject({
    code: "session_ownership_lost",
    nextAction: "acquire_new_session",
  });
});

test("a session the managed connection does not hold keeps its ordinary refusal", async () => {
  const { error } = await callThrough(readyManagedSlotsResult(SESSION), {
    throws: new DaemonBoundSessionExpiredError("other-session", "heartbeat_timeout"),
  });
  expect(error).toMatchObject({ code: "session_ownership_lost" });
});

test("a successful result on a managed connection passes through unchanged", async () => {
  const ok: CallToolResult = { content: [{ type: "text", text: '{"success":true}' }] };
  const { text } = await callThrough(readyManagedSlotsResult(SESSION), { returns: ok });
  expect(text).toBe('{"success":true}');
});

test("a read still succeeds after the release, and the refusal carries no role", async () => {
  const { server, proxy, registrations } = createHarness(readyManagedSlotsResult(SESSION));
  const ok: CallToolResult = { content: [{ type: "text", text: '{"hierarchy":[]}' }] };
  const call = spyOn(proxy, "callTool")
    .mockRejectedValueOnce(new DaemonBoundSessionExpiredError(SESSION, "idle-timeout"))
    .mockResolvedValue(ok);
  try {
    const handler = registrations.find(([schema]) => schema === CallToolRequestSchema)?.[1];
    if (!handler) {
      throw new Error("Missing handler");
    }
    const refused = await handler({ method: "tools/call", params: { name: "tapOn" } }, extra);
    const read = await handler({ method: "tools/call", params: { name: "observe" } }, extra);
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).error).not.toHaveProperty("role");
    expect(read.isError).toBeUndefined();
    expect(read.content[0].text).toBe('{"hierarchy":[]}');
  } finally {
    call.mockRestore();
    await server.close();
    await proxy.close();
  }
});
