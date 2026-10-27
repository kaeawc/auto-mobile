import { SingleFlight } from "../../utils/cache/SingleFlight";
import { stableStringify } from "../../utils/stableStringify";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import { DEFAULT_MCP_REQUEST_TIMEOUT_MS, ProgressExtendableDeadline } from "../mcpRequestTimeout";
import {
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
} from "../wire/constants";
import { McpTimeoutError } from "../wire/McpTimeoutError";
import { isHostInventoryCall, nextSocketRequestOrder } from "../socketRequestAdmission";
import type { McpForwardContext } from "../socketServerParts/socketServerContracts";

interface InventoryFlight {
  startOrder: number;
  deadlineMs: number;
  timeoutMs: number;
}

type ForwardInventory = (shared: McpForwardContext) => Promise<unknown>;

/** Share inventory work, never a caller's cancellation, deadline, or task handle. */
export class HostInventoryForward {
  private readonly flights = new SingleFlight<number, unknown>();
  private readonly joinable = new Map<string, InventoryFlight>();

  constructor(
    private readonly timer: Timer,
    private readonly idGenerator: IdGenerator,
  ) {}

  read(
    context: McpForwardContext,
    forward: ForwardInventory,
    minimumStartOrder = 0,
  ): Promise<unknown> | undefined {
    const { request, route } = context;
    if (
      request.method !== "tools/call" ||
      request.tasks !== undefined ||
      !isHostInventoryCall(request.params?.name, request.params?.arguments)
    ) {
      return undefined;
    }
    // Keep permission scopes separate: sharing must never skip another profile's gate.
    // Stable JSON normalizes nested key order while retaining every argument's semantics.
    const args = { ...request.params?.arguments };
    // These proxy-owned markers are stripped before dispatch and do not change inventory.
    delete args[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    delete args[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    // Different sessions with the same selection profile intentionally share work and errors.
    const key = stableStringify({
      name: request.params?.name,
      args,
      toolSelectionProfileUuid: route.toolSelectionProfileUuid ?? route.sessionUuid,
    });
    const remainingMs = context.deadline.value - this.timer.now();
    if (remainingMs <= 0) {
      return Promise.reject(this.timeoutError(context));
    }
    return raceWithDeadline(() => this.joinFlight(key, context, forward, minimumStartOrder), {
      timer: this.timer,
      signal: context.signal,
      timeoutMs: remainingMs,
      label: `Host inventory ${request.params?.name}`,
      timeoutError: () => this.timeoutError(context),
    });
  }

  private timeoutError(context: McpForwardContext): McpTimeoutError {
    return new McpTimeoutError({
      toolName: context.request.params?.name ?? "host inventory",
      timeoutMs: context.totalTimeoutMs,
      origin: "UnixSocketServer.handleRequest",
      detail: "waiting for shared host inventory",
    });
  }

  private joinFlight(
    key: string,
    context: McpForwardContext,
    forward: ForwardInventory,
    minimumStartOrder: number,
  ): Promise<unknown> {
    const flight = this.selectFlight(key, context, minimumStartOrder);
    return this.flights.run(
      flight.startOrder,
      async () => {
        try {
          return await forward(this.sharedContext(context, flight));
        } finally {
          if (this.joinable.get(key) === flight) {
            this.joinable.delete(key);
          }
        }
      },
      context.signal,
    );
  }

  private selectFlight(
    key: string,
    context: McpForwardContext,
    minimumStartOrder: number,
  ): InventoryFlight {
    const current = this.joinable.get(key);
    if (
      current &&
      current.startOrder > minimumStartOrder &&
      current.deadlineMs >= context.deadline.value
    ) {
      return current;
    }
    // A running transport's timeout is fixed. Start fresh rather than shorten a later waiter's
    // budget or let a read after any socket's barrier reuse a pre-barrier snapshot.
    const now = this.timer.now();
    const timeoutMs = Math.max(
      DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      context.totalTimeoutMs,
      context.deadline.value - now,
    );
    const flight = { startOrder: nextSocketRequestOrder(), deadlineMs: now + timeoutMs, timeoutMs };
    this.joinable.set(key, flight);
    return flight;
  }

  private sharedContext(context: McpForwardContext, flight: InventoryFlight): McpForwardContext {
    // Inventory owns a budget covering its waiters, independently of their cancellation.
    // Progress belongs to each caller; do not relay the first caller's token to joined callers.
    const request = {
      ...context.request,
      timeoutMs: flight.timeoutMs,
      progressToken: undefined,
    };
    return {
      ...context,
      request,
      // Socket disconnects cancel executions by session key too, beyond the caller's signal.
      socketSessionId: `host:inventory:${this.idGenerator.next()}`,
      signal: undefined,
      totalTimeoutMs: flight.timeoutMs,
      deadline: new ProgressExtendableDeadline(
        flight.deadlineMs - flight.timeoutMs,
        flight.timeoutMs,
      ),
    };
  }
}
