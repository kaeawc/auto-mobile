import { HostInventoryForward } from "../socketServer/hostInventoryForward";
import { isHostInventoryCall, latestBarrierCompletionOrder } from "../socketRequestAdmission";
import { ControlDiscoveryCache, runPassthroughForward } from "../socketServer/controlRoutes";

import { logger } from "../../utils/logger";

import { ProgressExtendableDeadline } from "../mcpRequestTimeout";

import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DaemonRequest, DaemonResponse } from "../types";
import {
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  DAEMON_ONE_SHOT_CLI_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
} from "../wire/constants";

import {
  registerLiveDeadline,
  unregisterLiveDeadline,
  getLiveTextRequestState,
} from "../liveDeadlineRegistry";

import { evaluateClientHandshake, extractClientHandshake } from "../wire/daemonHandshake";

import type { FeatureFlagAdmin } from "../../features/featureFlags/FeatureFlagService";

import { ActionableError } from "../../models/ActionableError";

import { type DaemonGenerationIdentity } from "../liveAcceptanceCapability";
import { daemonGenerationMatches } from "../processGeneration";

import { recordedProcessGenerationToken } from "../processGenerationFields";

import { parseTaskRelayFrame } from "../tasks/taskRelay";
import { callForwardedTool, forwardTaskRequest } from "../socketServer/taskRelayForward";
import {
  currentForwardSessionKey,
  currentForwardTaskOwnerKey,
  FORWARD_KEY_IDLE_MS,
  type ForwardMcpClient,
  runWithForwardSessionKey,
} from "../socketServer/forwardSessionKey";
import { runKeyedSerial, type McpForwardChainWait } from "../socketServer/keyedSerialQueue";

import {
  MAX_MCP_FORWARD_REROUTES,
  McpForwardAttempt,
  McpForwardRoute,
  McpForwardContext,
} from "./socketServerContracts";

import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
type State = Pick<
  SocketServerRuntime,
  | "handshakeEnforced"
  | "daemonIdentity"
  | "mcpForwardTails"
  | "mcpForwardIdleCloseKeys"
  | "timer"
  | "mcpClientFactory"
  | "identityStartedAt"
  | "processGenerationToken"
  | "identityProcessStartedAt"
  | "identityRepublishInFlight"
  | "onRepublishIdentity"
  | "featureFlagService"
  | "idGenerator"
  | "forwardedCallKeys"
  | "shapeToolCallError"
  | "onFrameTrace"
  | "sessions"
  | "mcpDispatcher"
  | "forwardKeyIdleTimers"
  | "appendTextInputs"
>;
type Callbacks = Pick<
  SocketServerOperations,
  | "clearForwardKeyIdleTimer"
  | "scheduleForwardKeyIdle"
  | "runKeyedMcpForward"
  | "runMcpForwardAttempt"
  | "getMcpForwardRoute"
  | "hasActiveDaemonSession"
  | "requireRemainingMcpForwardBudget"
  | "handleIdeRequest"
  | "getSessionUuid"
  | "currentGenerationIdentity"
  | "daemonGenerationMatches"
  | "publishIdentity"
  | "mcpRequestOptions"
  | "withAdmittedBoundSession"
  | "boundSessionAdmissionArgs"
  | "combineMcpRequestSignals"
  | "pushProgressNotification"
  | "withSocketSessionAutolockKey"
  | "traceCallTool"
  | "withLiveDeadlineKey"
  | "textForwardFailure"
  | "frameDeviceId"
  | "traceFrame"
  | "oneShotCliMarker"
  | "honoursBoundSessionMarker"
  | "recordOneShotCliConnection"
  | "onForwardKeyIdle"
  | "isMcpClientKeyBound"
>;
/** Mcp Execution over shared connection state and explicit callbacks. */
/** The deadline window and cancellation one forwarded IDE request runs under. */
export interface IdeForwardWindow {
  deadline: ProgressExtendableDeadline;
  /**
   * The FULL per-request timeout window this request was granted at
   * receipt (`totalTimeoutMs` from `handleRequest`) -- UNLIKE `timeoutMs`,
   * which is the budget remaining for THIS specific forward
   * attempt after time already spent waiting in the per-session queue
   * (or reconnecting). A request that waited most of its budget in queue
   * would otherwise have every progress-driven reset use that tiny
   * queue-depleted remnant as its "how long is ordinary device work
   * between ticks allowed to take" window -- collapsing a 30s tool to a
   * ~1s one. Every progress-driven extension (the SDK's own
   * `resetTimeoutOnProgress`, which reuses this SAME `timeout` value on
   * every reset, and this daemon's own `deadline`) uses THIS value
   * instead, independent of queue wait (#6222 review, P1).
   */
  originalTimeoutMs: number;
  signal?: AbortSignal;
}

export class McpExecution {
  private readonly discoveryCache: ControlDiscoveryCache;
  private readonly inventoryForward: HostInventoryForward;
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {
    this.inventoryForward = new HostInventoryForward(state.timer, state.idGenerator);
    this.discoveryCache = new ControlDiscoveryCache(
      () => this.state.mcpDispatcher.refreshResources?.() ?? Promise.resolve(),
      state.timer,
    );
  }
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }

  forgetSocketDiscovery(socketSessionId: string): void {
    this.discoveryCache.forgetSocket(socketSessionId);
  }
  /**
   * Reject an inbound request whose declared version/build identity does not match
   * this daemon (#2744). Returns an error response to short-circuit the request, or
   * null to let it through. Clients that declare no handshake fields (legacy, or the
   * gate disabled) always pass. This is the single, language-agnostic gate that
   * extends the TS proxy's build-identity enforcement to the Kotlin/Swift clients.
   */
  rejectOnHandshakeMismatch(request: DaemonRequest): DaemonResponse | null {
    if (!this.state.handshakeEnforced) {
      return null;
    }
    const evaluation = evaluateClientHandshake(
      this.state.daemonIdentity,
      extractClientHandshake(request),
    );
    if (evaluation.ok) {
      return null;
    }
    logger.warn(
      `Rejecting daemon client on handshake ${evaluation.reason} mismatch: ${evaluation.message}`,
    );
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: evaluation.message,
      handshakeFailure: {
        code: "daemon_identity_mismatch",
        phase: "daemon-preflight",
        executionStarted: false,
        reason: evaluation.reason,
        daemon: this.state.daemonIdentity,
        client: extractClientHandshake(request),
      },
    };
  }
  /**
   * Run one MCP forward at a time for a single execution target. Calls for different devices or
   * sessions can proceed concurrently while their loopback transports remain session-local.
   */
  runKeyedMcpForward<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
    chainWait?: McpForwardChainWait,
  ): Promise<T> {
    return runKeyedSerial(
      {
        tails: this.state.mcpForwardTails,
        idleCloseKeys: this.state.mcpForwardIdleCloseKeys,
        timer: this.state.timer,
        onAcquired: (key) => this.callbacks.clearForwardKeyIdleTimer(key),
        onDrained: (key) => this.callbacks.scheduleForwardKeyIdle(key),
      },
      executionKey,
      fn,
      idleCloseKey,
      chainWait,
    );
  }
  /**
   * Run `fn` holding the execution key of the request's current route. When the route moves
   * to another key while the request waits, the held key is RELEASED before the new one is
   * acquired: holding one key while waiting on another deadlocks two requests whose routes
   * cross, or one request whose route flips back to a key it still holds (issue #6388).
   */
  async runMcpForwardForCurrentRoute<T>(
    initialRoute: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (route: McpForwardRoute) => Promise<T>,
    chainWait?: McpForwardChainWait,
  ): Promise<T> {
    // Inventory reads share discovery rather than holding a global serial queue.
    // Distinct-key flights run discovery in parallel without a concurrency limit (known limitation).
    if (
      request.method === "tools/call" &&
      isHostInventoryCall(request.params?.name, request.params?.arguments)
    ) {
      return await fn(initialRoute);
    }
    const visitedKeys = [initialRoute.executionKey];
    let route = initialRoute;
    for (;;) {
      const admittedRoute = route;
      const attempt = await this.callbacks.runKeyedMcpForward(
        admittedRoute.executionKey,
        () => this.callbacks.runMcpForwardAttempt(admittedRoute, request, socketSessionId, fn),
        undefined,
        chainWait,
      );
      if (attempt.kind === "done") {
        return attempt.value;
      }
      route = attempt.route;
      visitedKeys.push(route.executionKey);
      if (visitedKeys.length > MAX_MCP_FORWARD_REROUTES + 1) {
        throw new ActionableError(
          `MCP request ${request.id} was re-routed more than ${MAX_MCP_FORWARD_REROUTES} times while waiting to run ` +
            `(execution keys: ${visitedKeys.join(" -> ")}). The target device or session kept changing; retry once it is stable.`,
        );
      }
      logger.debug(
        `[McpForward] rekey requestId=${request.id} initialExecutionKey=${admittedRoute.executionKey} currentExecutionKey=${route.executionKey}`,
      );
    }
  }
  async runMcpForwardAttempt<T>(
    initialRoute: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (route: McpForwardRoute) => Promise<T>,
  ): Promise<McpForwardAttempt<T>> {
    const routeOrPending = this.callbacks.getMcpForwardRoute(request, socketSessionId);
    const currentRoute = routeOrPending instanceof Promise ? await routeOrPending : routeOrPending;
    if (currentRoute.executionKey !== initialRoute.executionKey) {
      return { kind: "reroute", route: currentRoute };
    }
    // The execution target is unchanged, so this request keeps the client and
    // session it was admitted with. Re-resolving may replace a session-specific
    // clientKey with the shared unbound client (e.g. a mid-flight disconnect
    // cleared the binding before this recompute) under the same executionKey;
    // that would run the admitted tool with no tool-selection profile. Only the
    // execution target may be re-resolved, never the admitted client/session
    // (issue #4610).
    //
    // Exception: when the admitted route was seeded for a specific daemon
    // session and that session was RELEASED while this request waited in the
    // queue, invoking the stale session-scoped client would re-seed the released
    // UUID and RESURRECT the session (getOrCreateSession recreates it and
    // reacquires a device the caller never asked for). A mid-flight socket
    // disconnect, by contrast, leaves the daemon session live — so the daemon
    // session still being active is exactly what distinguishes a disconnect
    // (keep the admitted client, preserving the tool-selection profile above) from a
    // real release (re-resolve to the current, unseeded route). Only re-resolve
    // when the recompute actually points somewhere else (issue #4610).
    if (
      initialRoute.sessionUuid !== undefined &&
      currentRoute.clientKey !== initialRoute.clientKey &&
      !this.callbacks.hasActiveDaemonSession(initialRoute.sessionUuid)
    ) {
      logger.debug(
        `[McpForward] released-session re-resolve requestId=${request.id} releasedSession=${initialRoute.sessionUuid} clientKey=${initialRoute.clientKey} -> ${currentRoute.clientKey}`,
      );
      return {
        kind: "done",
        value: await fn(currentRoute),
      };
    }
    return {
      kind: "done",
      value: await fn(initialRoute),
    };
  }
  /**
   * Forward one request in process (#11820): its own MCP client and stateless server, named by
   * the socket session as its MCP session key, closed (cancelling what it left running) when the
   * forward ends.
   */
  async forwardMcpRequest(context: McpForwardContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const inventory = this.inventoryForward.read(
      context,
      (shared) => this.forwardUncachedMcpRequest(shared),
      latestBarrierCompletionOrder(),
    );
    if (inventory) {
      return await inventory;
    }
    const method = context.request.method;
    if (
      (method !== "tools/list" && method !== "resources/list") ||
      (method === "resources/list" && !this.state.mcpDispatcher.refreshResources)
    ) {
      return await this.forwardUncachedMcpRequest(context);
    }
    this.callbacks.requireRemainingMcpForwardBudget(
      context.request,
      context.totalTimeoutMs,
      context.deadline,
      "preparing discovery",
    );
    const result = await this.callbacks.withAdmittedBoundSession(context.request.params, () =>
      this.discoveryCache.read(context, () => this.forwardUncachedMcpRequest(context)),
    );
    context.signal?.throwIfAborted();
    this.callbacks.requireRemainingMcpForwardBudget(
      context.request,
      context.totalTimeoutMs,
      context.deadline,
      "refreshing discovery",
    );
    return result;
  }

  private async forwardUncachedMcpRequest(context: McpForwardContext): Promise<unknown> {
    const mcpClient = await runWithForwardSessionKey(
      context.socketSessionId,
      () =>
        this.state.mcpClientFactory(
          context.route.sessionUuid,
          context.route.toolSelectionProfileUuid,
          context.route.releasedSessionUuid,
        ),
      parseTaskRelayFrame(context.request.tasks)?.ownerKey,
    );
    try {
      context.signal?.throwIfAborted();
      const forwardRemainingMs = this.callbacks.requireRemainingMcpForwardBudget(
        context.request,
        context.totalTimeoutMs,
        context.deadline,
        "waiting in queues and preparing the MCP client",
      );
      return await this.callbacks.handleIdeRequest(
        mcpClient,
        context.request,
        forwardRemainingMs,
        context.socketSessionId,
        {
          deadline: context.deadline,
          originalTimeoutMs: context.totalTimeoutMs,
          signal: context.signal,
        },
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
  remainingMcpForwardBudget(input: { deadline: ProgressExtendableDeadline }): number {
    return input.deadline.value - this.state.timer.now();
  }
  wasRequestSessionActive(request: DaemonRequest): boolean {
    const sessionUuid =
      request.method === "tools/call"
        ? this.callbacks.getSessionUuid(request.params?.arguments)
        : undefined;
    return sessionUuid ? this.callbacks.hasActiveDaemonSession(sessionUuid) : false;
  }
  /** Compact label for debug logs (method + tool name or resource URI). */
  describeMcpForwardRequest(request: DaemonRequest): string {
    if (request.method === "tools/call") {
      const name = request.params?.name;
      return `method=tools/call tool=${typeof name === "string" ? name : "?"}`;
    }
    if (request.method === "resources/read") {
      const uri = request.params?.uri;
      return `method=resources/read uri=${typeof uri === "string" ? uri : "?"}`;
    }
    return `method=${request.method}`;
  }
  daemonGenerationMatches(params: Record<string, unknown>): boolean {
    return daemonGenerationMatches(this.callbacks.currentGenerationIdentity(), params);
  }
  currentGenerationIdentity(): DaemonGenerationIdentity {
    return {
      pid: process.pid,
      startedAt: this.state.identityStartedAt,
      ...(this.state.processGenerationToken === undefined
        ? {}
        : { processGenerationToken: this.state.processGenerationToken }),
      version: this.state.daemonIdentity.version,
      buildId: this.state.daemonIdentity.build.buildId,
      entryScript: this.state.daemonIdentity.build.entryScript,
    };
  }
  /** Local admin RPC, generation-bound; publication never reserves tool admission. */
  async republishDaemonIdentity(params: Record<string, unknown>): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    if (
      !this.callbacks.daemonGenerationMatches(params) ||
      recordedProcessGenerationToken(params) !== this.state.processGenerationToken ||
      params.processStartedAt !== this.state.identityProcessStartedAt
    ) {
      return { accepted: false, reason: "generation_changed" };
    }
    if (this.state.identityRepublishInFlight) {
      return this.state.identityRepublishInFlight;
    }
    this.state.identityRepublishInFlight = this.callbacks.publishIdentity();
    try {
      return await this.state.identityRepublishInFlight;
    } finally {
      this.state.identityRepublishInFlight = undefined;
    }
  }
  async publishIdentity(): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    if (!this.state.onRepublishIdentity) {
      return { accepted: false, reason: "republish_unavailable" };
    }
    try {
      const accepted = await this.state.onRepublishIdentity();
      return accepted ? { accepted: true } : { accepted: false, reason: "startup_pending" };
    } catch (error) {
      logger.warn("Failed to republish daemon identity", error);
      return { accepted: false, reason: "republish_failed" };
    }
  }
  requireFeatureFlagService(): FeatureFlagAdmin {
    if (!this.state.featureFlagService) {
      throw new Error("Feature flag service not available");
    }
    return this.state.featureFlagService;
  }
  async handleIdeRequest(
    mcpClient: ForwardMcpClient,
    request: DaemonRequest,
    timeoutMs: number,
    socketSessionId: string,
    { deadline, originalTimeoutMs, signal }: IdeForwardWindow,
  ): Promise<any> {
    signal?.throwIfAborted();
    const requestOptions = this.callbacks.mcpRequestOptions(timeoutMs, signal);
    const passthrough = runPassthroughForward({
      mcpClient,
      request,
      timeoutMs,
      options: requestOptions,
      admitted: (args, forward) => this.callbacks.withAdmittedBoundSession(args, forward),
      readAdmissionArgs: (r) => this.callbacks.boundSessionAdmissionArgs(r),
    });
    if (passthrough) {
      return await passthrough;
    }
    switch (request.method) {
      case "tools/call": {
        const progressToken = request.progressToken;
        // Cleanup includes the live dispatch evidence on every tools/call and
        // the abort timer on progress-capable calls.
        // Lets a handler on the
        // OTHER side of this same call (e.g. the `createSetUIStateHandler` handler) read this
        // exact `deadline`'s CURRENT (possibly progress-extended) value via
        // `liveDeadlineRegistry` instead of only the frozen snapshot forwarded
        // through `INTERNAL_MCP_REQUEST_TIMEOUT_PARAM` (issue #6222 P1 reopen).
        const liveDeadlineKey = this.state.idGenerator.next();
        this.state.forwardedCallKeys.set(request, liveDeadlineKey);
        registerLiveDeadline(liveDeadlineKey, deadline);
        let cleanup = () => unregisterLiveDeadline(liveDeadlineKey);
        let callOptions: Record<string, unknown> = requestOptions;
        if (progressToken !== undefined) {
          // A progress-emitting tool (e.g. a multi-field setUIState) needs
          // an ASYMMETRIC deadline that the SDK's own `timeout`/
          // `resetTimeoutOnProgress` cannot express: its `_resetTimeout`
          // reuses the exact SAME `timeout` value passed at setup for every
          // later reset, so there is no way through its public options to
          // have "the remaining, queue-adjusted budget before the first
          // tick, then the FULL original window after" -- setting `timeout`
          // to the full window up front would hand a request that waited
          // most of its budget in the per-session queue a fresh full window
          // BEFORE any progress exists, while the outer DaemonClient still
          // expires on its own (much smaller) remaining budget -- a
          // split-brain where the caller can time out while the daemon has
          // barely started (#6222 review, reconciliation). Conversely,
          // keeping `timeout` at the queue-adjusted remainder and relying
          // on `resetTimeoutOnProgress` would reset EVERY tick to that same
          // tiny remainder instead of the full window (#6222 review, P1).
          //
          // So this drives its own abort-based deadline instead, sharing
          // the SAME `deadline` object `requireRemainingMcpForwardBudget`
          // reads:
          //   - before any progress: aborts at `timeoutMs` (remaining
          //     budget), matching the outer client's own remaining budget.
          //   - on each REAL progress tick: `deadline.extendOnProgress`
          //     pushes the shared deadline forward by the FULL original
          //     window (`originalTimeoutMs`), bounded by its ceiling, and
          //     the abort is rearmed against the new remaining time.
          // The SDK's own `timeout`/`maxTotalTimeout` are set generously
          // (to the ceiling) purely as a backstop that should never fire
          // first in practice -- this controller is the actual authority.
          const controller = new AbortController();
          const armAbort = (delayMs: number): NodeJS.Timeout =>
            this.state.timer.setTimeout(
              () => controller.abort(`Request timed out after ${Math.max(delayMs, 0)}ms`),
              Math.max(delayMs, 0),
            );
          let abortTimer = armAbort(timeoutMs);
          const backstopMs = Math.max(deadline.ceiling - this.state.timer.now(), timeoutMs);
          const registeredLiveDeadlineKey = liveDeadlineKey;
          cleanup = () => {
            this.state.timer.clearTimeout(abortTimer);
            unregisterLiveDeadline(registeredLiveDeadlineKey);
          };
          callOptions = {
            ...requestOptions,
            signal: this.callbacks.combineMcpRequestSignals(signal, controller.signal),
            timeout: backstopMs,
            maxTotalTimeout: backstopMs,
            // Relay progress ticks back to the ORIGINATING socket session,
            // tagged with the client's own token — never a
            // daemon-fabricated one (#6205). Also extends the DAEMON's OWN
            // request deadline (the one `requireRemainingMcpForwardBudget`
            // checks before a retry) and this call's own abort timer, both
            // by the FULL original window, bounded by `deadline`'s ceiling
            // (#6222 review, reconciliation).
            onprogress: (notification: { progress: number; total?: number; message?: string }) => {
              this.state.timer.clearTimeout(abortTimer);
              deadline.extendOnProgress(this.state.timer.now(), originalTimeoutMs);
              abortTimer = armAbort(deadline.value - this.state.timer.now());
              this.callbacks.pushProgressNotification(socketSessionId, {
                requestId: request.id,
                progressToken,
                progress: notification.progress,
                total: notification.total,
                message: notification.message,
              });
            },
          };
        }
        try {
          return await this.callbacks
            .withAdmittedBoundSession(
              request.params.arguments,
              () => {
                const forwardedArguments = this.callbacks.withSocketSessionAutolockKey(
                  request.params.arguments,
                  socketSessionId,
                  timeoutMs,
                );
                return this.callbacks.traceCallTool(request, () =>
                  callForwardedTool(
                    mcpClient,
                    request,
                    this.callbacks.withLiveDeadlineKey(forwardedArguments, liveDeadlineKey),
                    callOptions,
                  ),
                );
              },
              socketSessionId,
            )
            .catch(async (error: unknown) => {
              const state = getLiveTextRequestState(liveDeadlineKey);
              if (!state?.hasPending()) {
                return this.callbacks.textForwardFailure(
                  liveDeadlineKey,
                  request.params.name,
                  error,
                );
              }
              const indeterminate = state.timeoutError(error)!;
              const remainingMs = deadline.value - this.state.timer.now();
              if (remainingMs > 0) {
                try {
                  await raceWithDeadline(state.settled(), {
                    timeoutMs: remainingMs,
                    timer: this.state.timer,
                    label: "Dispatched text settlement",
                  });
                } catch (waitError) {
                  // Settlement is best-effort within the original deadline; preserve the indeterminate answer.
                  logger.debug("Dispatched text settlement wait ended", waitError);
                }
              }
              return this.state.shapeToolCallError(indeterminate, {
                toolName: request.params.name,
                source: "MCP",
              });
            });
        } finally {
          cleanup();
        }
      }
      default:
        // `tasks/get`, `tasks/update` and `tasks/cancel` (#4668); anything else is refused.
        return await forwardTaskRequest(mcpClient, request, requestOptions);
    }
  }
  textForwardFailure(key: string, toolName: string, error: unknown) {
    // The daemon's deadline answer precedes DaemonClient.scheduleRequestTimeout,
    // which waits for budget + grace as a backstop for a silent daemon. The
    // primary text path clamps transport to deadline - TEXT_REQUEST_RESPONSE_MARGIN_MS
    // and returns its indeterminate result early.
    const indeterminate = getLiveTextRequestState(key)?.timeoutError(error);
    if (indeterminate) {
      return this.state.shapeToolCallError(indeterminate, { toolName, source: "MCP" });
    }
    throw error;
  }
  async traceCallTool<T>(request: DaemonRequest, callTool: () => Promise<T>): Promise<T> {
    if (!this.state.onFrameTrace) {
      return await callTool();
    }
    const deviceId = this.callbacks.frameDeviceId(request);
    this.callbacks.traceFrame("callTool_entered", request.id, deviceId);
    try {
      return await callTool();
    } finally {
      this.callbacks.traceFrame("callTool_settled", request.id, deviceId);
    }
  }
  /**
   * Merge {@link INTERNAL_LIVE_DEADLINE_KEY_PARAM} onto `args` when a live
   * deadline was registered for this call (issue #6222 P1 reopen) -- a no-op
   * when there is none, or `args` is not a plain forwardable object (e.g.
   * `null`/an array), in which case it is returned unchanged.
   */
  withLiveDeadlineKey(args: unknown, liveDeadlineKey: string | undefined): unknown {
    if (liveDeadlineKey === undefined || !args || typeof args !== "object" || Array.isArray(args)) {
      return args;
    }
    return {
      ...(args as Record<string, unknown>),
      [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: liveDeadlineKey,
    };
  }
  withSocketSessionAutolockKey(args: unknown, socketSessionId: string, timeoutMs: number): unknown {
    // Anchor the absolute deadline to THIS instant -- immediately before the
    // loopback `mcpClient.callTool` -- rather than letting the receiving
    // process re-derive it from `startTime + remainingMs` after its own HTTP
    // dispatch and admission/tool-selection repo reads have already consumed
    // part of `timeoutMs` (issue #6222 review, PRRT_kwDOP-GF5M6fuyts P1). See
    // `INTERNAL_MCP_REQUEST_DEADLINE_PARAM` for the full rationale.
    const deadlineMs = this.state.timer.now() + timeoutMs;
    if (args === null || args === undefined) {
      return {
        __mcpSessionId: socketSessionId,
        ...this.callbacks.oneShotCliMarker(socketSessionId),
        [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: timeoutMs,
        [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: deadlineMs,
      };
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return args;
    }
    const forwardedArgs = { ...args } as Record<string, unknown>;
    const usesBoundSession = this.callbacks.honoursBoundSessionMarker(
      forwardedArgs,
      socketSessionId,
    );
    delete forwardedArgs[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    delete forwardedArgs[DAEMON_OWNED_SESSIONS_PARAM];
    delete forwardedArgs[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    this.callbacks.recordOneShotCliConnection(socketSessionId, forwardedArgs);
    // Only the daemon asserts the loopback marker, from the connection's own declaration.
    delete forwardedArgs[INTERNAL_ONE_SHOT_CLI_PARAM];
    delete forwardedArgs[DAEMON_BOUND_SESSION_PARAM];
    delete forwardedArgs[DAEMON_RELEASED_SESSION_PARAM];
    // Connection-bound sessions are carried by the loopback transport header.
    // Released bindings are checked before this synchronous argument rewrite;
    // restart recovery reaches the same issued-session admission through the header.
    if (usesBoundSession) {
      delete forwardedArgs.sessionUuid;
    }
    return {
      ...forwardedArgs,
      __mcpSessionId: socketSessionId,
      ...this.callbacks.oneShotCliMarker(socketSessionId),
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: timeoutMs,
      [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: deadlineMs,
    };
  }
  /**
   * Consume a one-shot `--cli` connection's declaration (#11096) and remember it for the
   * connection: every later call on the socket is forwarded with the loopback marker.
   */
  recordOneShotCliConnection(
    socketSessionId: string,
    forwardedArgs: Record<string, unknown>,
  ): void {
    const declared = forwardedArgs[DAEMON_ONE_SHOT_CLI_PARAM] === true;
    delete forwardedArgs[DAEMON_ONE_SHOT_CLI_PARAM];
    const session = this.state.sessions.get(socketSessionId);
    if (declared && session) {
      session.oneShotCli = true;
    }
  }
  oneShotCliMarker(socketSessionId: string): Record<string, true> {
    return this.state.sessions.get(socketSessionId)?.oneShotCli
      ? { [INTERNAL_ONE_SHOT_CLI_PARAM]: true }
      : {};
  }
  /** Open the client one forward runs through: its own in-process server (#11820). */
  async createMcpClient(
    boundSessionUuid?: string,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): Promise<ForwardMcpClient> {
    return await this.state.mcpDispatcher.connect({
      boundSessionUuid,
      toolSelectionProfileUuid,
      releasedSessionUuid,
      sessionKey: currentForwardSessionKey(),
      taskOwnerKey: currentForwardTaskOwnerKey(),
    });
  }
  scheduleForwardKeyIdle(key: string): void {
    this.callbacks.clearForwardKeyIdleTimer(key);
    const timer = this.state.timer.setTimeout(() => {
      this.callbacks.onForwardKeyIdle(key);
    }, FORWARD_KEY_IDLE_MS);
    this.state.forwardKeyIdleTimers.set(key, timer);
  }
  clearForwardKeyIdleTimer(key: string): void {
    const timer = this.state.forwardKeyIdleTimers.get(key);
    if (!timer) {
      return;
    }
    this.state.timer.clearTimeout(timer);
    this.state.forwardKeyIdleTimers.delete(key);
  }
  /**
   * Nothing has used this execution key for the idle window. For a device key, drop the cached
   * append helper so its API-level probe cannot go stale across a device swap under the same id.
   */
  onForwardKeyIdle(key: string): void {
    this.state.forwardKeyIdleTimers.delete(key);
    if (this.state.mcpForwardTails.has(key) || this.callbacks.isMcpClientKeyBound(key)) {
      return;
    }
    const devicePrefix = "device:";
    if (key.startsWith(devicePrefix)) {
      this.state.appendTextInputs.delete(key.slice(devicePrefix.length));
    }
  }
}
