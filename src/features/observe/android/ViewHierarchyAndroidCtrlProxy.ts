import type { AndroidCtrlProxyClient } from "./AndroidCtrlProxyClient";

/**
 * The slice of the Android CtrlProxy client that ViewHierarchy exercises. The
 * recovery and connectivity probes are optional because a transport without
 * them is read as "not recovering / state unknown" (see the `?.` call sites).
 */
export type ViewHierarchyAndroidCtrlProxy = Pick<
  AndroidCtrlProxyClient,
  "getAccessibilityHierarchy" | "setRecompositionTrackingEnabled" | "getSdkScreenIdentity"
> &
  Partial<
    Pick<
      AndroidCtrlProxyClient,
      | "ensureRecoveryStarted"
      | "awaitRecovery"
      | "isRecoveryInFlight"
      | "getRestartBudgetSnapshot"
      | "isConnected"
    >
  >;
