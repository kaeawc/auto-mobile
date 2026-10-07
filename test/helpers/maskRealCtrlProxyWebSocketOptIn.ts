import { afterEach, beforeEach } from "bun:test";
import { REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV } from "../../src/features/observe/DeviceServiceClient";

/**
 * Clear {@link REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV} around each test in the
 * calling scope and restore it afterwards, so assertions that the default
 * WebSocket factory is guarded (#10470) cannot inherit a developer's exported
 * opt-in and dial a real socket instead.
 */
export function maskRealCtrlProxyWebSocketOptIn(): void {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV];
    delete process.env[REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV];
  });
  afterEach(() => {
    if (previous === undefined) {
      delete process.env[REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV];
    } else {
      process.env[REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV] = previous;
    }
  });
}
