import type { DaemonNotification, DaemonResponse } from "../types";
import { ListChangedBroadcaster, type ListChangedKind } from "../listChangedBroadcast";
import type { McpForwardContext } from "../socketServerParts/socketServerContracts";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

import { INTERNAL_MCP_REQUEST_TIMEOUT_PARAM } from "../wire/constants";
import type { GestureFrameKind, InputRouteEntry, InputRouteHandler } from "../inputRoutes";
import type { DaemonRequest } from "../types";

/**
 * Route tables for the control socket (#11815): which handler serves an `input/*` frame, whether a
 * local frame runs under the owner's abort fence, and how each simple forwarded MCP method reaches
 * the loopback client. The server supplies the handlers; this module owns the dispatch decisions so
 * they are testable with fakes and the server keeps only the composition.
 */

const INPUT_METHOD_PREFIX = "input/";

export function isInputMethod(method: string): boolean {
  return method.startsWith(INPUT_METHOD_PREFIX);
}

/** Input and device-mutating IDE frames share the forwarded MCP calls' owner fence; the rest run bare. */
export function isOwnerFencedMethod(
  method: string,
  ideMutationMethods: ReadonlySet<string>,
): boolean {
  return isInputMethod(method) || ideMutationMethods.has(method);
}

/** What an `input/*` handler is called with. `Ctx` is the server's request context. */
export type InputRouteHandlers<Ctx> = Readonly<{
  [H in Exclude<InputRouteHandler, "gesture">]: (
    request: DaemonRequest,
    socketSessionId: string | undefined,
    input: Ctx,
  ) => Promise<unknown>;
}> & {
  readonly gesture: (
    request: DaemonRequest,
    kind: GestureFrameKind,
    socketSessionId: string | undefined,
    input: Ctx,
  ) => Promise<unknown>;
};

/** Runs the handler an `input/*` route table entry names. */
export async function dispatchInputRoute<Ctx>(
  handlers: InputRouteHandlers<Ctx>,
  route: InputRouteEntry,
  request: DaemonRequest,
  socketSessionId: string | undefined,
  input: Ctx,
): Promise<unknown> {
  return route.handler === "gesture"
    ? await handlers.gesture(request, route.gestureKind, socketSessionId, input)
    : await handlers[route.handler](request, socketSessionId, input);
}

export interface ForwardedCallOptions {
  readonly timeout: number;
  readonly signal?: AbortSignal;
}

/** The slice of the loopback client the passthrough methods use; the SDK `Client` satisfies it. */
export interface PassthroughClient {
  listTools(params: undefined, options: ForwardedCallOptions): Promise<unknown>;
  listResources(params: undefined, options: ForwardedCallOptions): Promise<unknown>;
  readResource(params: { uri: string }, options: ForwardedCallOptions): Promise<unknown>;
  listResourceTemplates(params: undefined, options: ForwardedCallOptions): Promise<unknown>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options: ForwardedCallOptions,
  ): Promise<unknown>;
}

export interface PassthroughContext {
  readonly mcpClient: PassthroughClient;
  readonly request: DaemonRequest;
  readonly timeoutMs: number;
  readonly options: ForwardedCallOptions;
  /** Runs the forward after the bound session's admission; `args` are what admission inspects. */
  readonly admitted: <T>(args: unknown, forward: () => T) => T | Promise<T>;
  /** The args `resources/read` presents to admission (a released session's screenshot is exempt). */
  readonly readAdmissionArgs: (request: DaemonRequest) => unknown;
}

type PassthroughRoute = (ctx: PassthroughContext) => Promise<unknown>;

/** Forwarded MCP methods that are one SDK call behind bound-session admission. */
const PASSTHROUGH_ROUTES: ReadonlyMap<string, PassthroughRoute> = new Map<string, PassthroughRoute>(
  [
    [
      "tools/list",
      async (ctx) =>
        await ctx.admitted(ctx.request.params, () =>
          ctx.mcpClient.listTools(undefined, ctx.options),
        ),
    ],
    [
      "resources/list",
      async (ctx) =>
        await ctx.admitted(ctx.request.params, () =>
          ctx.mcpClient.listResources(undefined, ctx.options),
        ),
    ],
    [
      "resources/read",
      async (ctx) => {
        if (!ctx.request.params?.uri) {
          throw new Error("resources/read requires params.uri");
        }
        const uri = ctx.request.params.uri;
        return await ctx.admitted(ctx.readAdmissionArgs(ctx.request), () =>
          ctx.mcpClient.readResource({ uri }, ctx.options),
        );
      },
    ],
    [
      "resources/list-templates",
      async (ctx) =>
        await ctx.admitted(ctx.request.params, () =>
          ctx.mcpClient.listResourceTemplates(undefined, ctx.options),
        ),
    ],
    [
      "ide/getNavigationGraph",
      async (ctx) => {
        const args = {
          ...(ctx.request.params ?? {}),
          [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: ctx.timeoutMs,
        };
        return await ctx.mcpClient.callTool(
          { name: "getNavigationGraph", arguments: args },
          ctx.options,
        );
      },
    ],
  ],
);

/**
 * Starts a passthrough forwarded method and returns its promise, or `undefined` for the rest
 * (tools/call, tasks/*). Deliberately not `async`: the forward starts synchronously, as healthy
 * bound routing requires.
 */
export function runPassthroughForward(ctx: PassthroughContext): Promise<unknown> | undefined {
  return PASSTHROUGH_ROUTES.get(ctx.request.method)?.(ctx);
}

/** Already JSON-copied and SDK-validated answers. Only the small frame envelope varies per call. */
const serializedLists = new WeakMap<object, string>();

/** Preserve JSON.stringify's field order and escaping while reusing the large result's bytes. */
export function serializeControlFrame(frame: DaemonResponse | DaemonNotification): string {
  const result: unknown = "result" in frame ? frame.result : undefined;
  const serialized = result && typeof result === "object" ? serializedLists.get(result) : undefined;
  if (serialized === undefined) {
    return JSON.stringify(frame) + "\n";
  }
  return (
    "{" +
    Object.entries(frame)
      .flatMap(([key, value]) => {
        const bytes = key === "result" ? serialized : JSON.stringify(value);
        return bytes === undefined ? [] : [`${JSON.stringify(key)}:${bytes}`];
      })
      .join(",") +
    "}\n"
  );
}

function discoveryListKind(method: string): ListChangedKind | undefined {
  if (method === "tools/list") {
    return "tools";
  }
  return method === "resources/list" ? "resources" : undefined;
}

interface Entry {
  readonly socketSessionId: string;
  readonly generation: number;
  readonly result: object;
}

/**
 * Control-socket discovery only (#13550). A miss uses the normal MCP hop, including its JSON
 * boundary and SDK result validation. A hit reuses that validated result and serialized bytes.
 * Socket identity is deliberately part of the scope: its keyed SessionToolBindingStore can
 * override the seeds and must never share another connection's answer, even with equal seeds.
 */
export class ControlDiscoveryCache {
  private readonly entries = new Map<string, Entry>();
  // One refresh at a time: a hit that stopped waiting leaves it running for the next hit to share.
  private inFlightRefresh: Promise<void> | undefined;
  constructor(
    private readonly refreshResources: () => Promise<void>,
    private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  ) {}
  // Bound retention across disconnected/churning scopes; eviction only makes the next read cold.
  private static readonly MAX_ENTRIES = 128;

  forgetSocket(socketSessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.socketSessionId === socketSessionId) {
        this.entries.delete(key);
      }
    }
  }

  async read(context: McpForwardContext, load: () => Promise<unknown>): Promise<unknown> {
    const kind = discoveryListKind(context.request.method);
    if (!kind) {
      return await load();
    }
    context.signal?.throwIfAborted();
    const { route } = context;
    const key = JSON.stringify([
      kind,
      context.socketSessionId,
      route.clientKey,
      route.sessionUuid,
      route.toolSelectionProfileUuid,
      route.releasedSessionUuid,
    ]);
    const entry = this.entries.get(key);
    if (kind === "resources" && entry?.generation === ListChangedBroadcaster.generation(kind)) {
      // Devices/apps can change outside AutoMobile. Keep the list refresher contract on hits,
      // outside the caller's async context just as the loopback server would run it. Misses
      // still refresh in the MCP handler; a changed generation below falls through to it.
      if (!(await this.awaitWarmRefresh(context))) {
        // Past the deadline: McpExecution's budget check reports the MCP timeout, so never cold-load.
        return entry.result;
      }
      context.signal?.throwIfAborted();
    }
    const generation = ListChangedBroadcaster.generation(kind);
    if (entry?.generation === generation) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.result;
    }
    this.entries.delete(key);
    const result = await load();
    context.signal?.throwIfAborted();
    this.retain(kind, key, generation, result, context.socketSessionId);
    return result;
  }

  /**
   * Wait for the warm hit's resource refresh, bounded by the request's cancellation and its MCP
   * deadline (#14522), so a stalled installed-app or device refresh cannot pin the keyed execution
   * lane. Resolves false when the deadline passes first; an abort rejects with its reason.
   */
  private async awaitWarmRefresh(context: McpForwardContext): Promise<boolean> {
    const refresh = (this.inFlightRefresh ??= this.refreshResources().finally(() => {
      this.inFlightRefresh = undefined;
    }));
    const expired = new Error("warm resources/list refresh passed the MCP deadline");
    try {
      await raceWithDeadline(refresh, {
        timer: this.timer,
        signal: context.signal,
        timeoutMs: Math.max(0, context.deadline.value - this.timer.now()),
        label: "Warm resources/list refresh",
        timeoutError: () => expired,
      });
      return true;
    } catch (error) {
      if (error !== expired) {
        throw error;
      }
      // The caller turns the spent budget into the request's MCP timeout; this only stops waiting.
      logger.debug(`[DiscoveryCache] ${expired.message}; the refresh keeps running.`);
      return false;
    }
  }

  private retain(
    kind: ListChangedKind,
    key: string,
    generation: number,
    result: unknown,
    socketSessionId: string,
  ): void {
    // A notification during the await fences out this fill. Never retain errors or old epochs.
    if (
      generation !== ListChangedBroadcaster.generation(kind) ||
      !result ||
      typeof result !== "object"
    ) {
      return;
    }
    serializedLists.set(result, JSON.stringify(result));
    this.entries.set(key, { generation, result, socketSessionId });
    if (this.entries.size > ControlDiscoveryCache.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }
}
