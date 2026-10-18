import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import {
  forwardMcpRequestInProcess,
  type InProcessForwardPort,
  type McpForwardContext,
} from "../../src/daemon/socketServer/inProcessForward";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import { currentForwardSessionKey } from "../../src/daemon/socketServer/forwardSessionKey";
import type { DaemonRequest } from "../../src/daemon/types";

/** #11815: the in-process forward moved out of UnixSocketServer, driven through a fake port. */
function makeContext(signal?: AbortSignal): McpForwardContext {
  return {
    request: { id: "1", method: "tools/call" } as DaemonRequest,
    route: { clientKey: "c", executionKey: "e", sessionUuid: "s", toolSelectionProfileUuid: "p" },
    socketSessionId: "socket-1",
    signal,
    totalTimeoutMs: 1000,
    deadline: new ProgressExtendableDeadline(0, 1000),
  };
}

function makePort(options: { closeFails?: boolean; handlerFails?: boolean } = {}) {
  const events: string[] = [];
  const client = {
    close: async () => {
      events.push("close");
      if (options.closeFails) {
        throw new Error("close failed");
      }
    },
  } as never as Client;
  const port: InProcessForwardPort = {
    mcpClientFactory: () => async (bound, profile, released) => {
      events.push(`open:${bound}:${profile}:${released}:${currentForwardSessionKey()}`);
      return client;
    },
    requireRemainingBudget: (_request, _total, _deadline, phase) => {
      events.push(`budget:${phase}`);
      return 750;
    },
    handleIdeRequest: async (_client, _request, remaining, socketSessionId) => {
      events.push(`handle:${remaining}:${socketSessionId}`);
      if (options.handlerFails) {
        throw new Error("handler failed");
      }
      return "answer";
    },
  };
  return { port, events };
}

describe("forwardMcpRequestInProcess", () => {
  test("opens a keyed client, runs the request with the remaining budget, then closes", async () => {
    const { port, events } = makePort();
    expect(await forwardMcpRequestInProcess(port, makeContext())).toBe("answer");
    expect(events).toEqual([
      "open:s:p:undefined:socket-1",
      "budget:waiting in queues and preparing the MCP client",
      "handle:750:socket-1",
      "close",
    ]);
  });

  test("a close failure never replaces the forward's answer", async () => {
    const { port } = makePort({ closeFails: true });
    expect(await forwardMcpRequestInProcess(port, makeContext())).toBe("answer");
  });

  test("closes the client when the request fails", async () => {
    const { port, events } = makePort({ handlerFails: true });
    await expect(forwardMcpRequestInProcess(port, makeContext())).rejects.toThrow("handler failed");
    expect(events.at(-1)).toBe("close");
  });

  test("an already-aborted signal opens no client", async () => {
    const { port, events } = makePort();
    const controller = new AbortController();
    controller.abort();
    await expect(
      forwardMcpRequestInProcess(port, makeContext(controller.signal)),
    ).rejects.toThrow();
    expect(events).toEqual([]);
  });
});
