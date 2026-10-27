import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../../src/features/observe/android";

/**
 * `AndroidCtrlProxyClient.getInstance()` returns the narrow `AndroidCtrlProxy` interface. Tests that
 * exercise the real client's internals (timers, socket factories, incarnation tracking) narrow it
 * back to the concrete class here, failing loudly if a fake was installed instead.
 */
export function concreteCtrlProxyClient(client: AndroidCtrlProxy): AndroidCtrlProxyClient {
  if (!(client instanceof AndroidCtrlProxyClient)) {
    throw new Error("Expected the real AndroidCtrlProxyClient, not a fake");
  }
  return client;
}
