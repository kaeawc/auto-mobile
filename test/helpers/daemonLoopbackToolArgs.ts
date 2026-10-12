import {
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
} from "../../src/daemon/constants";

/** Mirror socketServer's ownership-metadata removal in adapters that bypass its loopback hop. */
export function daemonLoopbackToolArgs(params: Record<string, unknown>): Record<string, unknown> {
  const forwardedArgs = { ...params };
  delete forwardedArgs[DAEMON_OWNED_SESSIONS_PARAM];
  delete forwardedArgs[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
  return forwardedArgs;
}
