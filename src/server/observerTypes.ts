import type { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";

/** The observer surface the shutdown path needs to tear down an invalidated client. */
export type Invalidatable = Pick<AndroidCtrlProxyClient, "invalidateForShutdownRecovery" | "close">;

/** The observer surface the shutdown reconnect path needs. */
export type Reconnectable = Invalidatable & Pick<AndroidCtrlProxyClient, "ensureConnected">;
