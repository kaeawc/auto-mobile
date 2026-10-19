import { INTERNAL_MCP_REQUEST_TIMEOUT_PARAM } from "../constants";
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
