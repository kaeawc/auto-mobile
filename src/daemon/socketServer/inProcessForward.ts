import type { Client } from "@modelcontextprotocol/client";
import type { DaemonRequest } from "../types";
import type { ProgressExtendableDeadline } from "../mcpRequestTimeout";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { parseTaskRelayFrame } from "../../server/tasks/taskRelay";
import { runWithForwardSessionKey, type McpClientFactory } from "./forwardSessionKey";
import type { McpForwardRoute } from "./McpForwardRouter";

/** One MCP forward ready to run in process (#11820). */
export interface McpForwardContext {
  request: DaemonRequest;
  route: McpForwardRoute;
  socketSessionId: string;
  /** Aborted when the Unix-socket client that owns this forward disconnects. */
  signal?: AbortSignal;
  totalTimeoutMs: number;
  /**
   * Mutable: a progress notification for THIS request extends `.value`, up to
   * its own bounded ceiling (issue #6222 review, P1). Every consumer must
   * read `.value` live rather than caching it, so a pre-flight budget check
   * made after progress has already extended the deadline sees the extended
   * value, not the original one.
   */
  deadline: ProgressExtendableDeadline;
}

/** The server-owned collaborators an in-process forward needs; each is resolved per call. */
export interface InProcessForwardPort {
  /** The factory that opens the forward's MCP client. */
  mcpClientFactory(): McpClientFactory;
  /** Throws when the request has no budget left; returns the remaining milliseconds. */
  requireRemainingBudget(
    request: DaemonRequest,
    totalTimeoutMs: number,
    deadline: ProgressExtendableDeadline,
    phase: string,
  ): number;
  /** Run the request through `mcpClient`, applying the ide/* and tools/call routing. */
  handleIdeRequest(
    mcpClient: Client,
    request: DaemonRequest,
    remainingMs: number,
    socketSessionId: string,
    deadline: ProgressExtendableDeadline,
    totalTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Forward one request in process (#11820): its own MCP client and stateless server, named by
 * the socket session as its MCP session key, closed (cancelling what it left running) when the
 * forward ends.
 */
export async function forwardMcpRequestInProcess(
  port: InProcessForwardPort,
  context: McpForwardContext,
): Promise<unknown> {
  context.signal?.throwIfAborted();
  const mcpClient = await runWithForwardSessionKey(
    context.socketSessionId,
    () =>
      port.mcpClientFactory()(
        context.route.sessionUuid,
        context.route.toolSelectionProfileUuid,
        context.route.releasedSessionUuid,
      ),
    parseTaskRelayFrame(context.request.tasks)?.ownerKey,
  );
  try {
    context.signal?.throwIfAborted();
    const forwardRemainingMs = port.requireRemainingBudget(
      context.request,
      context.totalTimeoutMs,
      context.deadline,
      "waiting in queues and preparing the MCP client",
    );
    return await port.handleIdeRequest(
      mcpClient,
      context.request,
      forwardRemainingMs,
      context.socketSessionId,
      context.deadline,
      context.totalTimeoutMs,
      context.signal,
    );
  } finally {
    // A close failure must never replace the forward's own answer.
    await Promise.resolve()
      .then(() => mcpClient.close())
      .catch((error: unknown) => {
        logger.warn(`Closing an MCP forward failed: ${errorMessage(error)}`, error);
      });
  }
}
