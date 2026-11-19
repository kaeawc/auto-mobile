# MCP SDK v2: tasks and skills extensions

Part of [MCP SDK v2 and the stateless daemon layer](sdk-v2-stateless-migration.md).

## Tasks extension (#4668)

Tasks are stored in SQLite, so a restarted daemon still answers `tasks/get` and `tasks/cancel`. A
task holding a device keeps that session's lease alive while it is `working` or `input_required`.
Finished tasks stay readable for 10 minutes by default.

**SDK support.** The SDK packages do not implement the extension. What they do provide:

- the 2025-11-25 core task vocabulary (`ttl`, `pollInterval`,
  `tasks/result`, `tasks/list`, `params.task`), only as deprecated types "with no SDK runtime";
- the `tasks/*` method names for `Mcp-Name` header routing;
- lifting of the per-request
  `_meta` envelope (`io.modelcontextprotocol/clientCapabilities`) into `ctx.mcpReq.envelope`;
- lifting of a request's top-level `inputResponses` into `ctx.mcpReq.inputResponses`.

The SDK installs `server/discover` only on a server serving the 2026-07-28 era, which the daemon HTTP endpoint can
serve with `AUTOMOBILE_MCP_MODERN_ERA`. The separate
`@modelcontextprotocol/ext-tasks` package is client-side and not a dependency. The wire is
therefore implemented on our own handlers, per the extension specification (revision
2026-07-28 of modelcontextprotocol/ext-tasks).

**Negotiation.** A request declares the extension in its per-request client capabilities;
declarations are never remembered. A `tools/call` that did not declare it never gets a task,
and `tasks/get`, `tasks/update` and `tasks/cancel` without it answer `-32021`. Because there is
no `server/discover` on the 2025 era, the server advertises the extension in its `initialize`
result, and only to a client whose `initialize` declared it; every other client sees the
`initialize` result unchanged. Modern HTTP servers advertise it in `server/discover`.

The legacy advertisement is an AutoMobile extension of the spec (#13143): SEP-2663 leaves the
extension undefined on `2025-11-25`. It is not gated on the legacy client's `protocolVersion`.

**Pieces** (`src/server/tasks/`):

- `TaskManager` (interface, `DefaultTaskManager`, test `FakeTaskManager`): ids from
  `IdGenerator`, time from the injected `Timer`, statuses `working`, `input_required`,
  `completed`, `failed`, `cancelled`. A terminal status never changes. `ttlMs` is null while a
  task runs and becomes terminal time plus retention minus creation once it settles. On first
  use, a manager fails every running task another daemon instance left behind ("Task
  interrupted"). A foreign session's task is reported exactly like a missing one.
- `McpTaskRepository` (`src/db/mcpTaskRepository.ts`, table `mcp_tasks`, migration
  `2026_10_18_000_mcp_tasks`): owner key, status, instance id, timestamps, retention, and the
  JSON result, error or input requests. The repository fences status writes on a running status. The table
  lives in the daemon's own `auto-mobile.db` (`src/db`), not in the host-wide session broker
  registry file, because a daemon's session key owns each task.
- `runAsTask(options, work)`: the seam a tool call opts into. It needs a request that declared the
  extension and carries a session key, on a server that serves tasks. Then it creates the task durably and starts
  the work in the background under a policy-specific `AbortSignal`. The `abort` policy passes the task's
  signal to the existing cooperative request-cancellation path. The `detach` policy passes an independent
  signal unaffected by `tasks/cancel`. It turns progress ticks into the task's `statusMessage`
  and returns the `CreateTaskResult`. Otherwise it runs the work synchronously. The `currentTaskContext()` call gives
  code inside the work the task id, `holdDeviceLease(sessionUuid)` and `requestInput(...)`.
- `TaskLeaseKeepalive`: the hook a task uses to keep a device session's lease alive until its work
  ends. The `HeartbeatTaskLeaseKeepalive` class renews the session through the session manager's own
  `recordHeartbeat` (the path the socket and HTTP heartbeat routes use, owner lease only, never
  the idle clocks). It renews at once and then at half the session's heartbeat timeout (at most every
  second). A hold ends when the work settles (including work continuing after a detached
  cancellation), when the session ends under it, or at daemon shutdown
  (`releaseDaemonTaskLeases`). The daemon's per-request servers get the daemon-scoped instance
  from `createStatelessMcpServer`; direct stdio holds nothing.
- `TASK_ELIGIBILITY`: per-call eligibility and cancellation policy. `startDevice`,
  `executePlan`, `installApp` and `setUIState` use cooperative `abort`; `videoRecording` with
  `action: "stop"` uses `detach` (#13090). A cancelled `setUIState` stops before its next field.
  Its task drops the request's forwarded transport deadline and runs under its own whole-call
  budget (#18531). Recording start and other actions stay synchronous, and calls from
  non-declaring clients still block. `taskEligibleByName` adapts name allowlists to the `abort` policy.
- Stop task cancellation: cancelling a stop task promptly reports `cancelled` with
  a message that work continues. That ends client polling while the stop finishes and keeps its
  device lease. Its later result cannot overwrite cancellation, and the daemon logs later failures at
  warning level. A second stop joins the existing in-flight stop, and the finalized artifact
  remains retrievable.
- `startDevice` leases: the work holds
  the session it binds (`currentTaskContext()?.holdDeviceLease`) right after the bind, so the
  session cannot lapse before the client learns its id from `tasks/get`. The boot itself binds
  no session until it is ready. So `tasks/cancel` during the boot runs the existing
  undelivered-acquisition rollback: the boot stops and nothing stays bound.
- `executePlan` leases (#13088): the plan holds its base and routed session as the handler starts. It holds each label
  session once it publishes the label map (`holdTaskDeviceLeases`, idempotent per task). Its execution registers
  under the task's scope with the same binding key and session UUID, so `PlanExecutionLock`
  keeps blocking that session's calls until the plan ends. A `tasks/cancel` aborts the task's
  signal, which the execution combines with its own. The plan then unwinds and ends its execution
  (releasing the lock) as a cancelled synchronous call does.
- `createSdkMcpServer` passes a `CreateTaskResult` through the SDK's `tools/call` result
  validation, which would otherwise stamp `content: []` on it.

**Scope.** Tasks are served by the daemon's per-request servers (HTTP endpoint and in-process
forwards); a task's owner is the explicit session key, because a keyless request's scope id is
one-off. Direct stdio serves no tasks.

**Stdio proxy relay.** The proxy (`src/server/proxyServer.ts`, `DaemonMcpProxy`) is a transparent
participant:

- It advertises the extension on `initialize` only to a declaring client.
- It forwards a
  `tools/call`'s declaration as a `tasks` field on the control-socket frame (`{ownerKey,
  declared}`).
- It relays `tasks/get`, `tasks/update` (with the input responses the SDK lifts to
  `ctx.mcpReq.inputResponses`) and `tasks/cancel`. It refuses an undeclared `tasks/*` request with
  the same `-32021` the daemon sends.

The proxy mints the owner key once per proxy process
(`proxy-tasks:<id>`), so a task stays reachable after the proxy reconnects to a restarted daemon.
The socket's own session id would not stay reachable. The daemon's in-process forward passes the key to the
request server as `taskOwnerKey` and replays the declaration.

The SDK client on that hop lifts
`resultType` off every result. The forward therefore restores it (`resultType: "task"` on a task handle,
`"complete"` on `tasks/*` results). A `tasks/*` JSON-RPC error travels on the frame as
`jsonRpcError`, so the proxy answers with the daemon's code, message and data. Frames for `tasks/*`
skip the socket's admission queue: a poll never waits behind a long call on the same socket. The proxy
reconnects a lost daemon connection and asks the request once more. A daemon that stays
unreachable is an error, never an invented status. Device-binding tools are not relayed as
declared until the proxy binds the session from a completed task's result.
`notifications/tasks` push is out of scope (task polling only).

## Skills extension (#15430)

SDK 2.4.0's Skills over MCP extension publishes one usage skill, `auto-mobile-usage`
(`mcp-skills/`, listed in `package.json` `files`). `createMcpServer` and the proxy call
`attachUsageSkill`, which attaches one shared `SkillsExtension` over a lazy `SkillSource`.
Construction is synchronous because the daemon builds stateless servers per request. The source
reads the folder once on first use. A folder that cannot be read serves no skills.

`attach` registers the skill file reads on the SDK's `resources/read` handler, but our
`resources/read` handlers replace it (see "Handlers stay ours"). So the resource
registry and the proxy answer `skill://` URIs themselves from the same source. A
`skill://` URI that source does not serve is a not-found error, never a forward to the
daemon or an `automobile:` scheme suggestion. The skill is absent from `tools/list`,
`resources/list` and `resources/templates/list`; hosts reach it only through
the Skills extension's list and get requests. The skill also adds `extensions` to the `initialize`
capabilities.
