import { expect } from "bun:test";
import { DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM } from "../../src/daemon/wire/constants";

/** Exact forwarded arguments include the proxy identity independently of retained sessions. */
export function withProxyOwnerToken(
  params: Record<string, unknown>,
  token: string = expect.any(String),
) {
  return { ...params, [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: token };
}
