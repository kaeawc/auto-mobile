/**
 * The subset of `DEVICE_SESSION_ACQUISITION_TOOLS` a client on a DEFAULT
 * connection can actually discover and call, and therefore the only ones worth
 * naming in recovery guidance. Two registration flags disqualify a tool:
 * `startDevice` is `hidden: true` (`src/server/deviceTools.ts`), so it never
 * appears in `tools/list` and cannot be enabled through `setToolEnabled`
 * either; `provisionDevice` is `defaultEnabled: false`, so default discovery
 * omits it and call enforcement rejects it (`src/server/index.ts`) — a client
 * following advice that named either had nothing to call. Advertised in every
 * `session_ownership_lost` / `no_active_device_session` recovery payload
 * (ownership loss is built by {@link sessionOwnershipLostPayload}) and in the prose that
 * accompanies them (`src/daemon/daemonMcpProxy.ts`). Pinned to the registry by
 * `test/server/deviceSessionRecoveryTools.test.ts`.
 */
export const DEVICE_SESSION_RECOVERY_TOOLS = ["getAndroid", "getApple"] as const;
