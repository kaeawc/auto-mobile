import type { IncomingHttpHeaders } from "node:http";
import { createMcpServer, type McpServerOptions } from "../server";
import { daemonTaskLeaseKeepalive } from "./tasks/daemonTaskManager";
import {
  DAEMON_RELEASED_SESSION_HEADER,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_HEADER,
} from "./wire/constants";
import type { StatelessMcpRequestScope } from "./statelessMcpHttpEndpoint";

/**
 * The one place a daemon MCP request's server is built (#4678 stateless, #11820): the HTTP
 * endpoint reads the request's context from its headers, a control-socket forward hands over the
 * same fields as a struct, and both reach {@link createStatelessMcpServer} with an identical
 * session context.
 */

/** A forward's context as the control socket holds it: the values of the loopback headers. */
export interface McpForwardRequestContext {
  readonly boundSessionUuid?: string;
  readonly releasedSessionUuid?: string;
  readonly toolSelectionProfileUuid?: string;
}

/** Where a request's context comes from: an HTTP request's headers, or a socket forward. */
export type McpRequestContextSource =
  | { readonly headers: IncomingHttpHeaders }
  | McpForwardRequestContext;

/** The request-derived part of `McpServerOptions.sessionContext`. */
export interface McpRequestSessionContext {
  initialSessionToolBinding?: string;
  initialReleasedSession?: string;
  initialToolSelectionProfile?: string;
}

/** The daemon-wide part of a request server's options, fixed when the daemon starts. */
export type StatelessMcpServerBase = Pick<
  McpServerOptions,
  | "deviceReadiness"
  | "iosDependencies"
  | "debug"
  | "acceptanceDiscoveryCapability"
  | "sessionToolBindingStore"
  | "deviceChoiceRequestState"
>;

// Fetch's `Headers` strips leading and trailing HTTP whitespace from a value before sending it,
// so a forward's struct value is normalized the same way to reach the same context.
const HTTP_WHITESPACE_EDGES = /^[\t\n\r ]+|[\t\n\r ]+$/g;

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function sentValue(value: string | undefined): string | undefined {
  // The loopback client sets a header only for a non-empty value.
  return value ? value.replace(HTTP_WHITESPACE_EDGES, "") : undefined;
}

function nonBlank(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Build a request's session context. A bound session the caller also marked released is not
 * bound: the released marker wins, so the request is refused as released rather than run.
 */
export function buildMcpRequestContext(source: McpRequestContextSource): McpRequestSessionContext {
  const read = contextReader(source);
  const bound = read(DAEMON_SESSION_TOOL_BINDING_HEADER, "boundSessionUuid");
  const released = read(DAEMON_RELEASED_SESSION_HEADER, "releasedSessionUuid");
  const profile = read(DAEMON_TOOL_SELECTION_PROFILE_HEADER, "toolSelectionProfileUuid");
  const boundIsReleased = released !== undefined && released.trim() === bound?.trim();
  return {
    ...(nonBlank(bound) && !boundIsReleased ? { initialSessionToolBinding: bound } : {}),
    ...(nonBlank(released) ? { initialReleasedSession: released } : {}),
    ...(nonBlank(profile) ? { initialToolSelectionProfile: profile } : {}),
  };
}

/** Reads one context field from the headers, or from the forward's struct as it would be sent. */
function contextReader(
  source: McpRequestContextSource,
): (header: string, field: keyof McpForwardRequestContext) => string | undefined {
  if ("headers" in source) {
    const { headers } = source;
    return (header) => headerValue(headers, header);
  }
  return (_header, field) => sentValue(source[field]);
}

/**
 * Build one request's MCP server (#4678 stateless). The request scope id is the session id of its
 * session context, so the executions it starts cancel with the request; the caller's
 * session key travels as `requestMcpSessionId`. Keyed bindings live in the daemon-scoped store.
 * A task the request starts outlives it and keeps its device session's lease alive through the
 * daemon-scoped keepalive (#4668).
 */
export function createStatelessMcpServer(
  base: StatelessMcpServerBase,
  context: McpRequestSessionContext,
  scope: StatelessMcpRequestScope,
): ReturnType<typeof createMcpServer> {
  return createMcpServer({
    ...base,
    ...(scope.era !== undefined && { era: scope.era }),
    ...(scope.taskOwnerKey !== undefined && { taskOwnerKey: scope.taskOwnerKey }),
    sessionContext: { ...context, sessionId: scope.requestScopeId },
    daemonMode: true,
    requestMcpSessionId: scope.requestMcpSessionId,
    ...(scope.trustedForwarder === true && { trustForwardedMcpSessionId: true }),
    stateless: true,
    taskLeaseKeepalive: daemonTaskLeaseKeepalive(),
  });
}

/** The resource-list freshness hook shared by the MCP handler and control discovery cache. */
export { refreshMcpResourceList } from "../server";
