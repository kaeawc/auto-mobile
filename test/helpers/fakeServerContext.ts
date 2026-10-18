import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * The SDK v2 request context (`ctx`) a server request handler receives, for suites that
 * invoke a registered handler directly (issue #4678). It replaces the v1 `extra` object
 * (`signal`, `requestId`, `sendNotification`, `sendRequest`) those suites used to pass.
 */
export function fakeServerContext(
  options: {
    signal?: AbortSignal;
    id?: string | number;
    notify?: (notification: unknown) => Promise<void>;
  } = {},
): ServerContext {
  const context = {
    mcpReq: {
      id: options.id ?? 1,
      method: "tools/call",
      _meta: undefined,
      signal: options.signal ?? new AbortController().signal,
      notify: options.notify ?? (async () => {}),
      send: async () => {
        throw new Error("Unexpected server request");
      },
    },
  };
  return context as ServerContext;
}
