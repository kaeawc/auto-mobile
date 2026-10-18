/**
 * Typed seam for substituting the Android CtrlProxy client in tests; the Android
 * counterpart of {@link ./iosCtrlProxyClientSpies}.
 *
 * `AndroidCtrlProxyClient.getInstance` is declared to return the concrete class, so a
 * partial method stub needs one narrowing step. It lives here, once, instead of a
 * double cast through `unknown` at every call site (#11863).
 */

import { spyOn } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";

/** Anything a test substitutes for the client: a fake or a partial method stub. */
type AndroidClientStub = object;

function asClient(stub: AndroidClientStub): AndroidCtrlProxyClient {
  return stub as AndroidCtrlProxyClient;
}

/** Make `AndroidCtrlProxyClient.getInstance` return `client` until the spy is restored. */
export function spyOnAndroidClientInstance(client: AndroidClientStub) {
  return spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(asClient(client));
}
