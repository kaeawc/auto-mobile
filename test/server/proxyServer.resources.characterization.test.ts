import { expect, spyOn, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { ActionableError } from "../../src/models";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
  DaemonRestartDeferredError,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonShuttingDownError } from "../../src/daemon/client";
import { McpOverloadError } from "../../src/daemon/McpTimeoutError";
import { DeviceControlTransportError } from "../../src/daemon/deviceControlTransportFailure";

function createHarness() {
  const registration = spyOn(Server.prototype, "setRequestHandler");
  const harness = createProxyMcpServer({
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

const requests = [
  [
    ListResourcesRequestSchema,
    "resources/list",
    "listAdvertisedResources",
    "Failed to list resources from daemon",
  ],
  [
    ListResourceTemplatesRequestSchema,
    "resources/templates/list",
    "listAdvertisedResourceTemplates",
    "Failed to list resource templates from daemon",
  ],
  [
    ReadResourceRequestSchema,
    "resources/read",
    "readResource",
    "Failed to read resource from daemon",
  ],
] as const;

const extra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: async () => {},
  sendRequest: async () => {
    throw new Error("Unexpected request");
  },
};

test.each([
  [new DaemonBoundSessionExpiredError("session-a", "released"), "session_ownership_lost"],
  [new DaemonConnectionSessionReleasedError("released"), "no_active_device_session"],
  [new DaemonShuttingDownError(), "daemon_shutting_down"],
  [new DaemonShuttingDownError(true), "requestMayHaveDispatched"],
  [new DaemonRestartDeferredError("version mismatch"), "daemon_restart_deferred"],
  [
    new McpOverloadError("overloaded", {
      code: "daemon_overloaded",
      retryable: true,
      retryAfterMs: 250,
      reason: "insufficient_forward_budget",
      queueWaitMs: 0,
      remainingTimeoutMs: 500,
    }),
    "daemon_overloaded",
  ],
  [
    new DeviceControlTransportError("transport failed", {
      code: "device_control_transport_failure",
      transport: "daemon_loopback_http",
      toolName: "observe",
      sessionValid: true,
      deviceSessionValid: true,
      phase: "response",
      retryable: false,
      reconnectAttempted: false,
      replayAttempted: false,
    }),
    "device_control_transport_failure",
  ],
  [new Error("generic failure"), "generic failure"],
] as const)("tools/call maps %s to its error result", async (failure, expected) => {
  const { server, proxy, registrations } = createHarness();
  const call = spyOn(proxy, "callTool").mockRejectedValue(failure);
  try {
    const handler = registrations.find(([schema]) => schema === CallToolRequestSchema)?.[1];
    if (!handler) {
      throw new Error("Missing handler");
    }
    const result = await handler({ method: "tools/call", params: { name: "observe" } }, extra);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(expected);
    expect(call).toHaveBeenCalledWith("observe", {}, undefined, undefined, extra.signal);
  } finally {
    call.mockRestore();
    await server.close();
    await proxy.close();
  }
});

test.each(requests)(
  "resource handler %s preserves generic failures",
  async (schema, method, delegate, message) => {
    const { server, proxy, registrations } = createHarness();
    const failure = new Error("unavailable");
    const forwarding = spyOn(proxy, delegate).mockRejectedValue(failure);
    try {
      const handler = registrations.find(([registered]) => registered === schema)?.[1];
      if (!handler) {
        throw new Error("Missing handler");
      }
      const result = Promise.resolve(
        handler({ method, params: { uri: "automobile:test" } }, extra),
      );
      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toMatchObject({
        message: `${message}: unavailable`,
        cause: failure,
      });
      expect(forwarding).toHaveBeenCalledTimes(1);
    } finally {
      forwarding.mockRestore();
      await server.close();
      await proxy.close();
    }
  },
);

test("resource handlers preserve response envelopes and forward the read signal", async () => {
  const { server, proxy, registrations } = createHarness();
  const resources = [{ uri: "automobile:test", name: "Test" }];
  const templates = [{ uriTemplate: "automobile:test/{id}", name: "Test" }];
  const contents = { contents: [{ uri: "automobile:test", text: "result" }] };
  const list = spyOn(proxy, "listAdvertisedResources").mockResolvedValue(resources);
  const listTemplates = spyOn(proxy, "listAdvertisedResourceTemplates").mockResolvedValue(
    templates,
  );
  const read = spyOn(proxy, "readResource").mockResolvedValue(contents);
  try {
    const expected = [{ resources }, { resourceTemplates: templates }, contents];
    for (const [index, [schema, method]] of requests.entries()) {
      const handler = registrations.find(([registered]) => registered === schema)?.[1];
      if (!handler) {
        throw new Error("Missing handler");
      }
      expect(await handler({ method, params: { uri: "automobile:test" } }, extra)).toEqual(
        expected[index],
      );
    }
    expect(read).toHaveBeenCalledWith("automobile:test", { signal: extra.signal });
  } finally {
    list.mockRestore();
    listTemplates.mockRestore();
    read.mockRestore();
    await server.close();
    await proxy.close();
  }
});

test("missing resource URI rejects before forwarding", async () => {
  const { server, proxy, registrations } = createHarness();
  const read = spyOn(proxy, "readResource");
  try {
    const handler = registrations.find(([schema]) => schema === ReadResourceRequestSchema)?.[1];
    if (!handler) {
      throw new Error("Missing handler");
    }
    await expect(
      Promise.resolve(handler({ method: "resources/read", params: {} }, extra)),
    ).rejects.toThrow("Resource URI is missing in the request");
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    await server.close();
    await proxy.close();
  }
});
