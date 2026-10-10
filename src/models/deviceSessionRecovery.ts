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

/**
 * `nextAction` on a terminal-session refusal (`session_ownership_lost`, `no_active_device_session`):
 * the named session UUID is gone for good, so the client must acquire a NEW session rather than
 * retry the UUID. Such a refusal carries `retryable: false` for the UUID (#11098).
 */
export const ACQUIRE_NEW_SESSION_NEXT_ACTION = "acquire_new_session" as const;

/**
 * Wire code of a managed connection's answer to a call after its execution's session was terminally
 * released (#11341). `session_ownership_lost` would tell the agent to acquire a new session, which a
 * managed connection never does (`getAndroid`/`getApple` are always refused there), so the managed
 * proxy answers this instead.
 */
export const MANAGED_EXECUTION_ENDED_CODE = "managed_execution_ended" as const;

/**
 * `nextAction` on {@link MANAGED_EXECUTION_ENDED_CODE}: the runner, not the agent, decides whether
 * to relaunch the execution, which acquires fresh slot sessions. The refusal names no recovery tools.
 */
export const RELAUNCH_EXECUTION_NEXT_ACTION = "relaunch_execution" as const;
