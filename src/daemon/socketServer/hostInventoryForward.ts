import { SingleFlight } from "../../utils/cache/SingleFlight";
import { stableStringify } from "../../utils/stableStringify";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Timer } from "../../utils/SystemTimer";
import { DEFAULT_MCP_REQUEST_TIMEOUT_MS, ProgressExtendableDeadline } from "../mcpRequestTimeout";
import {
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
} from "../constants";
import { McpTimeoutError } from "../McpTimeoutError";
import { isHostInventoryCall } from "../socketRequestAdmission";
import type { McpForwardContext } from "../socketServerParts/socketServerContracts";

/** Share inventory work, never a caller's cancellation, deadline, or task handle. */
export class HostInventoryForward {
  private readonly flights = new SingleFlight<string, unknown>();

  constructor(
    private readonly timer: Timer,
    private readonly idGenerator: IdGenerator,
  ) {}

  read(
    context: McpForwardContext,
    forward: (shared: McpForwardContext) => Promise<unknown>,
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
    const key = stableStringify({
      name: request.params?.name,
      args,
      toolSelectionProfileUuid: route.toolSelectionProfileUuid ?? route.sessionUuid,
    });
    return raceWithDeadline(
      () => this.flights.run(key, () => forward(this.sharedContext(context)), context.signal),
      {
        timer: this.timer,
        signal: context.signal,
        timeoutMs: context.deadline.value - this.timer.now(),
        label: `Host inventory ${request.params?.name}`,
        timeoutError: () =>
          new McpTimeoutError({
            toolName: request.params?.name ?? "host inventory",
            timeoutMs: context.totalTimeoutMs,
            origin: "UnixSocketServer.handleRequest",
            detail: "waiting for shared host inventory",
          }),
      },
    );
  }

  private sharedContext(context: McpForwardContext): McpForwardContext {
    // Inventory owns a bounded ordinary discovery budget, independently of the first waiter.
    // Progress belongs to each caller; do not relay the first caller's token to joined callers.
    const request = {
      ...context.request,
      timeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      progressToken: undefined,
    };
    return {
      ...context,
      request,
      // Socket disconnects cancel executions by session key too, beyond the caller's signal.
      socketSessionId: `host:inventory:${this.idGenerator.next()}`,
      signal: undefined,
      totalTimeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      deadline: new ProgressExtendableDeadline(this.timer.now(), DEFAULT_MCP_REQUEST_TIMEOUT_MS),
    };
  }
}
