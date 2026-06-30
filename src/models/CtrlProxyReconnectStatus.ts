export interface CtrlProxyReconnectStatus {
  state: "cooldown";
  retryAfterMs: number;
  retryAfterSeconds: number;
  connectionAttempts: number;
  maxConnectionAttempts: number;
}
