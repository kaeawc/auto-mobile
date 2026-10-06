# Environment Variables

Most users can use the defaults. Set these variables when you need a different
state directory, logs, tool set, or device behavior.

Tables list every public environment read in `src/`, including supported legacy
aliases. In a cell with two names, the first spelling takes precedence when set
(even if empty); exceptions are explained in that row. Defaults are effective
behavior with the variable unset. Boolean parsing varies by setting: use the
exact accepted values shown rather than assuming every flag accepts `true`.
Unknown numeric values usually fall back unless the row states otherwise.
Internal test/acceptance hooks, benchmark harness settings, and manager-injected
launch metadata are intentionally excluded.

## State and logs

<div class="environment-variable-table" markdown>

| Variable                                                      | Use and accepted values                                                                                                                                                                             | Default                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `AUTOMOBILE_DATA_DIR`, `AUTO_MOBILE_DATA_DIR`                 | Base directory for observe, accessibility, navigation, CtrlProxy builds, screen streaming, WebRTC, tool outputs and daemon failure artifacts; filesystem path, relative to daemon launch directory. | `~/.auto-mobile` (OS temp fallback if home is unavailable) |
| `AUTOMOBILE_LOG_DIR`, `AUTO_MOBILE_LOG_DIR`                   | Daemon and client log directory; filesystem path, relative to daemon launch directory.                                                                                                              | `$AUTOMOBILE_DATA_DIR/logs`                                |
| `AUTOMOBILE_LOG_FORMAT`, `AUTO_MOBILE_LOG_FORMAT`             | Log serialization: `text` or newline-delimited `json`; case-insensitive, trimmed.                                                                                                                   | `text`                                                     |
| `AUTOMOBILE_LOG_SINK`, `AUTO_MOBILE_LOG_SINK`                 | Log destination: `file`, `stderr`, `both`; case-insensitive, trimmed.                                                                                                                               | `file`                                                     |
| `AUTOMOBILE_LOG_LEVEL`, `AUTO_MOBILE_LOG_LEVEL`               | Initial logging threshold: `debug`, `info`, `warn`/`warning`, `error`, `none`/`silent`; case-insensitive, trimmed.                                                                                  | `info`                                                     |
| `AUTOMOBILE_COORDINATION_DIR`, `AUTO_MOBILE_COORDINATION_DIR` | Shared cross-process CtrlProxy forwarding lease root; must be an absolute path shared by cooperating agents.                                                                                        | OS account home `.auto-mobile`                             |
| `AUTOMOBILE_TOOL_OUTPUTS_DIR`, `AUTO_MOBILE_TOOL_OUTPUTS_DIR` | Directory for large CLI tool-output artifacts; filesystem path. CLI `--tool-outputs-dir` wins.                                                                                                      | resolved data directory `tool_outputs`                     |
| `AUTOMOBILE_DEBUG`                                            | Enable CLI debug logging; exact `1` enables.                                                                                                                                                        | off                                                        |
| `AUTOMOBILE_DEBUG_PERF`                                       | Enable UI performance debug tracking; exact `1` enables (also `--debug-perf`/`--ui-perf-debug`).                                                                                                    | off                                                        |
| `AUTOMOBILE_DOCTOR_TIMEOUT_MS`                                | Doctor command execution timeout; numeric milliseconds via `Number(value)`; zero, empty or NaN falls back to `5000`; use a positive value.                                                          | `5000` ms                                                  |

</div>

For container log collection:

```bash
export AUTOMOBILE_DATA_DIR=/var/lib/automobile
export AUTOMOBILE_LOG_FORMAT=json
export AUTOMOBILE_LOG_SINK=stderr
```

Some persistent stores still use fixed paths under `~/.auto-mobile`, including
device snapshots, video archives, and downloaded libwebp tools. Set their
feature-specific options where available; `AUTOMOBILE_DATA_DIR` does not
currently relocate them.

Set `AUTOMOBILE_COORDINATION_DIR` when the OS account home is read-only or when
AutoMobile agents that share an ADB server need an explicit shared lease root.
All cooperating agents must use the same absolute path. The legacy
`AUTO_MOBILE_COORDINATION_DIR` alias is accepted when the preferred name is
unset.

## Daemon namespace

<div class="environment-variable-table" markdown>

| Variable                                                                                                    | Use and accepted values                                                                                                                         | Default                                         |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `AUTOMOBILE_DAEMON_SOCKET_PATH`, `AUTO_MOBILE_DAEMON_SOCKET_PATH`                                           | Daemon control socket; filesystem path.                                                                                                         | `/tmp/auto-mobile-daemon-<uid>.sock`            |
| `AUTOMOBILE_DAEMON_PID_FILE_PATH`, `AUTO_MOBILE_DAEMON_PID_FILE_PATH`                                       | Daemon PID record; filesystem path.                                                                                                             | `/tmp/auto-mobile-daemon-<uid>.pid`             |
| `AUTOMOBILE_DAEMON_LOCK_FILE_PATH`, `AUTO_MOBILE_DAEMON_LOCK_FILE_PATH`                                     | Daemon start lock; filesystem path.                                                                                                             | `/tmp/auto-mobile-daemon-<uid>.lock`            |
| `AUTOMOBILE_AUX_SOCKET_DIR`                                                                                 | Directory for auxiliary stream/push sockets; filesystem path.                                                                                   | `~/.auto-mobile`                                |
| `AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH`, `AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH`                             | Override WebRTC stream socket; filesystem path.                                                                                                 | auxiliary socket directory `webrtc-stream.sock` |
| `AUTOMOBILE_DAEMON_TIMEOUT_MS`, `AUTO_MOBILE_DAEMON_TIMEOUT_MS`                                             | Connection/request timeout; positive base-10 integer milliseconds.                                                                              | `120000` ms                                     |
| `AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS`, `AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS`                             | Cold startup budget; positive base-10 integer prefix in milliseconds, capped at `2147483647`.                                                   | `30000` ms                                      |
| `AUTOMOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS`, `AUTO_MOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS` | Reachability wait for an already-live daemon; positive base-10 integer milliseconds, capped at two-thirds of the startup budget (minimum 1 ms). | `10000` ms, subject to cap                      |
| `AUTOMOBILE_DAEMON_DISABLE_HANDSHAKE`, `AUTO_MOBILE_DAEMON_DISABLE_HANDSHAKE`                               | Disable version/build identity handshake with `1`, `true`, `yes` (case-insensitive, trimmed).                                                   | off; handshake enabled                          |
| `AUTOMOBILE_DAEMON_STREAM_AUTH`                                                                             | Require session authentication on video/WebRTC sockets; `0`, `false`, `no`, `off` disable (case-insensitive, trimmed).                          | on                                              |
| `AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS`, `AUTO_MOBILE_OPEN_LINK_MCP_TIMEOUT_MS`                               | MCP timeout floor for `openLink`; positive base-10 integer milliseconds.                                                                        | `90000` ms                                      |
| `AUTOMOBILE_OBSERVE_MCP_TIMEOUT_MS`, `AUTO_MOBILE_OBSERVE_MCP_TIMEOUT_MS`                                   | MCP timeout floor for `observe`; positive base-10 integer milliseconds.                                                                         | `90000` ms                                      |
| `AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS`, `AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS`                         | Steady-state CtrlProxy readiness budget; integer milliseconds in `1000..120000`; CLI flag wins.                                                 | `30000` ms                                      |

</div>

Set `AUTOMOBILE_DAEMON_SOCKET_PATH`, `AUTOMOBILE_DAEMON_PID_FILE_PATH`, and
`AUTOMOBILE_DAEMON_LOCK_FILE_PATH` to distinct absolute paths for each concurrent
instance. Relative paths resolve from the daemon launch directory. The legacy
`AUTO_MOBILE_` aliases are also accepted.

Start, stop, and restart operate only on that namespace. A live process in
another namespace is ignored, even when it uses the default TCP port. Lost PID
records can still be recovered when the daemon answers on this socket or carries
this socket's launch marker. An unmarked process that does not answer on this
socket is left alone. Restart verifies and stops the namespace's current
process generation before launching its replacement; it reuses the recorded
bound port unless explicitly overridden, and fails if shutdown or identity
cannot be verified.

## Database

<div class="environment-variable-table" markdown>

| Variable                                                                        | Use and accepted values                                                                                                                                               | Default                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `AUTOMOBILE_DB_PATH`, `AUTO_MOBILE_DB_PATH`                                     | Exact SQLite database file; filesystem path, takes precedence over DB directory. `:memory:` is test-only.                                                             | `~/.auto-mobile/auto-mobile.db`                                      |
| `AUTOMOBILE_DB_DIR`, `AUTO_MOBILE_DB_DIR`                                       | Directory containing `auto-mobile.db`; filesystem path.                                                                                                               | unset; `~/.auto-mobile`                                              |
| `AUTOMOBILE_MIGRATIONS_DIR`, `AUTO_MOBILE_MIGRATIONS_DIR`                       | Directory containing SQL migrations; filesystem path.                                                                                                                 | migrations directory beside the database module (or its `db/` child) |
| `AUTOMOBILE_MIGRATION_RECOVERY`, `AUTO_MOBILE_MIGRATION_RECOVERY`               | Safe migration-history recovery is enabled unless `0`, `false`, `no`, `off` (case-insensitive, trimmed). Only exact trimmed `1` also permits destructive table reset. | safe recovery on; destructive reset off                              |
| `AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS`, `AUTO_MOBILE_MIGRATION_LOCK_TIMEOUT_MS` | File-scoped migration lock wait; positive base-10 integer milliseconds.                                                                                               | `60000` ms                                                           |

</div>

`AUTOMOBILE_DB_PATH` takes precedence over `AUTOMOBILE_DB_DIR`. Relative paths
are resolved from the daemon's launch directory. Use a path unique to each
concurrent instance:

```bash
export AUTOMOBILE_DB_PATH="$PWD/.auto-mobile/auto-mobile.db"
```

Do not use `AUTOMOBILE_DB_PATH=:memory:` in production. It is allowed only
for tests that also set `AUTOMOBILE_ALLOW_IN_MEMORY_DB=1`.

## Tool defaults

<div class="environment-variable-table" markdown>

| Variable                                        | Use and accepted values                                                                                                                                                                                                                                                                                         | Default            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `AUTOMOBILE_ENABLED_TOOLS`                      | Enable comma-separated exact, case-sensitive tool names; unknown names and conflicts fail startup. CLI flags win; persisted choices override startup defaults.                                                                                                                                                  | unset; no override |
| `AUTOMOBILE_DISABLED_TOOLS`                     | Disable comma-separated exact, case-sensitive tool names; same validation and precedence as enabled tools.                                                                                                                                                                                                      | unset; no override |
| `AUTOMOBILE_ALWAYS_LOAD_TOOLS`                  | Register optional tool definitions eagerly; exact `true` enables.                                                                                                                                                                                                                                               | off                |
| `AUTOMOBILE_OBSERVE_RESULT_INCLUDE_ELEMENTS`    | Include flattened `elements` in observations; exact `1` enables, or corresponding CLI flag.                                                                                                                                                                                                                     | off                |
| `AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT` | Omit structured tool content; exact `1` enables, or corresponding CLI flag.                                                                                                                                                                                                                                     | off                |
| `AUTOMOBILE_ACTIONS_DIFF_OBSERVE`               | Use differential action observations; exact `1` enables, or corresponding CLI flag.                                                                                                                                                                                                                             | off                |
| `AUTOMOBILE_ACTIONS_NO_OBSERVE`                 | Skip post-action observation; exact `1` enables, or corresponding CLI flag.                                                                                                                                                                                                                                     | off                |
| `AUTOMOBILE_ACTIONS_COMPACT_METADATA`           | Omit deeply equal previously inline-sent action metadata per session/device and identical duplicate matched elements; exact `1` or `--actions-compact-metadata` enables. First/changed/new-session/device-switch blocks are sent in full. Applies after action diffs; no-observe leaves only duplicate removal. | off                |
| `AUTOMOBILE_EVENT_ALL_MARKERS`                  | Comma-separated, trimmed event markers that promote matching events to all-event capture; `--event-all-markers` wins.                                                                                                                                                                                           | empty list         |

</div>

```bash
export AUTOMOBILE_ENABLED_TOOLS=clipboard,sqlQuery
export AUTOMOBILE_DISABLED_TOOLS=observe
```

Tool names are exact and case-sensitive. Unknown names and same-layer
enable/disable conflicts fail startup. Repeatable `--enable-tool` and
`--disable-tool` flags override these environment values; persisted
`setToolEnabled` choices override startup defaults.

## Session heartbeat timeout

<div class="environment-variable-table" markdown>

| Variable                                                                                              | Use and accepted values                                                                                    | Default    |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| `AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS`, `AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS`                 | Heartbeat leash; positive base-10 integer milliseconds.                                                    | `10000` ms |
| `AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS`, `AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS`   | Heartbeat expiry sweep cadence; positive base-10 integer milliseconds.                                     | `10000` ms |
| `AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS`, `AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS`     | Initial grace for custom-heartbeat sessions before first heartbeat; positive base-10 integer milliseconds. | `20000` ms |
| `AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS`, `AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS` | Grace for default-policy sessions that never heartbeat; positive base-10 integer milliseconds.             | `5000` ms  |

</div>

`AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS` (alias
`AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS`) defaults to `10000` ms. It controls
the heartbeat leash for heartbeat-policy sessions, not `cli-idle` sessions.
The proxy's default heartbeat cadence derives from this timeout.

```bash
export AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS=20000
```

Liveness ownership has a single token per session, and the daemon protects it.
A claim from a different token is rejected while the current owner's lease is
live. The lease is the session's heartbeat timeout measured from the owner's
last heartbeat (or its recorded claim), the same deadline the heartbeat monitor
reaps on, so a claim succeeds exactly when the session would otherwise be
released. Only the owner's own heartbeats extend the owner's lease: a tool call
that names the session, from any caller, keeps the session in use but does not
keep a dead owner's lease alive, so a restarted proxy with a new token can claim
once the lease plus the 10 s grace window have passed even while it is already
working on the session. A healthy single proxy is unaffected, since its own
heartbeats keep the lease live. Two claimants racing for a lapsed session are
serialised: the first records the takeover and its lease in the same step, and
the second is refused. A claim succeeds
when the session is unowned, the owner's lease has expired, or the token matches
the current owner (a restarted owner resuming). A session on the CLI idle policy
never has a live lease for this purpose: its one-shot CLI owners exit between
invocations, so the next invocation's new token can always claim it.

A rejected claim returns
`{ success: false, code: "liveness_owner_conflict", error: "..." }` naming the
session and changes nothing: the owner, policy, and every deadline stay as the
owner left them. A claim from a token that already claimed and was displaced
returns `{ success: false, code: "liveness_owner_superseded", error: "..." }`
and records nothing; it never succeeds silently and can never take the session
back. To take a session from a displaced owner, claim with a fresh token after
that owner's lease has expired.

A stdio/HTTP proxy bound with `--initial-session-uuid` claims on its first
heartbeat and restores the strict heartbeat policy. By default the proxy mints a
new owner token per process, so a restarted proxy is a different token and is
locked out while the previous process's lease is live. A harness that restarts
its proxy passes a stable token with `--liveness-owner-token <token>` (alongside
`--initial-session-uuid`); the restarted proxy then claims with the same token
and resumes the session without a conflict. Use a distinct token per harness. A
keeper for a one-shot CLI session can claim with
`--daemon heartbeat S --liveness-owner-token T --claim-liveness-ownership`;
that CLI claim adopts the CLI idle policy described below, and is refused on a
proxy-owned session (see "Supported liveness stack"). Ordinary ticks from the
current owner refresh deadlines without changing the policy.

A displaced token's non-claiming `daemon/heartbeat` returns
`{ success: false, code: "liveness_owner_superseded", error: "..." }` and changes
no activity, heartbeat, expiry or policy. The heartbeat CLI exits non-zero with
guidance to re-claim or stop, instead of printing `heartbeat recorded`. There is
no co-ownership.

The proxy treats supersession as informational, logs it once at debug level,
and continues without fencing, reconnecting or releasing the session. Only the
current owner's ticks protect liveness: a proxy stall past the heartbeat timeout
can therefore reap the session even while a displaced external keeper ticks.
Legacy tokenless heartbeats after a token has claimed ownership remain
successful no-ops. Missing or releasing sessions still return
`daemon_session_not_found`. A keeper cannot currently claim through the
heartbeat CLI without adopting its CLI policy.

### Supported liveness stack

The only supported liveness stack is harness → stdio proxy → daemon. The harness
proves liveness to its proxy over stdio; the proxy is the only liveness owner of
the sessions it holds, and heartbeats and claims them at the daemon with its
owner token. Nothing else should heartbeat a proxy's session.

`--daemon heartbeat` is the keeper for one-shot `--cli` sessions only, and it
refuses a proxy-owned session. A session is proxy-owned when a token has
claimed it under the strict `heartbeat` policy. The command sends a keeper
marker, and the daemon answers every claim or tick against such a session with
`{ success: false, code: "liveness_owner_is_proxy", error: "..." }` before
any ownership logic runs, whatever token the keeper presents and whether or not
the proxy's lease is still live. The refusal changes nothing: owner, policy and
every deadline stay as the proxy left them. The command exits non-zero and prints
the message, the `[liveness_owner_is_proxy]` code, and the instruction to stop
the keeper. This is distinct from `liveness_owner_conflict`, which is a
different token's claim on a live lease and can succeed once the lease expires.
Keeping a one-shot CLI session alive with `--daemon heartbeat` behaves as before.

A harness checks a session's state with `--daemon session-info <session-id>`. It
prints the session's `assignedDevice`, `platform`, `lastUsedAt`, `expiresAt` and,
while the session is being released, `releasing: true`. A missing session fails
with `daemon_session_not_found`. The harness reads this to decide whether a session
survived; it must not heartbeat the session itself to find out. It also prints
`liveness`: `{ state: "live" | "suspect", remainingMs }`, the time left on the
lease (live) or on the 10 s grace window (suspect).

### Stalled liveness: `daemon_stalled` and `proxy_stalled`

When a lease expires the daemon does not release the session at once: it holds
it as suspect for a 10 s grace window with its device still reserved for the
owner token. A heartbeat from the owner token inside the window restores the
session with the same UUID; no tool call runs against a suspect session until
then. The proxy uses that window for its own recovery, so a stall is reported to
the harness only when recovery has failed. Recovery always fits inside the lease
plus the grace window (20 s at the default 10 s timeout) at the 2 s and 5 s
heartbeat cadences. The proxy applies this to every session it holds, one
session at a time. The daemon does not hold its own stalls against owners: when
its heartbeat monitor runs more than 2 s later than scheduled it moves every
session's lease forward by exactly that lateness, so a daemon stall of a few
seconds cannot push a heartbeating owner past lease plus grace.

When the lease and grace are already spent by the time recovery starts (a long
proxy stall, such as a sleeping laptop), the daemon may have forgiven its own
stall and still hold the sessions, so each attempt is given the heartbeat
request timeout (half the lease, at most twice the heartbeat interval) instead
of a share of the exhausted budget.

Two distinct states, each with exactly three automatic recovery attempts:

- `daemon_stalled`: the daemon's socket is open or reconnectable but heartbeat
  acknowledgements stop. Each attempt reconnects if needed and heartbeats again
  with the same owner token. From the second attempt a silent socket may be
  replaced with a fresh one, but at most once per recovery episode (shared by
  every session recovering together, because the socket is one connection for
  all of them) and never while a tool call is in flight on it, unless an attempt
  has already seen the socket fail at the transport level. A held session the
  daemon answers "not found" is dropped once rather than retried, and a session
  that failed recovery is not recovered again before its handover. An attempt that is acknowledged ends the episode and the
  session stays usable; nothing is surfaced to the harness and the recovery is
  logged. The proxy also starts this recovery when a tool call is refused with
  `daemon_session_suspect`, the daemon's signal that the session still exists and
  its owner can restore it.
- `proxy_stalled`: the proxy's own heartbeat tick fired later than the lease
  allows, which it can only notice after it resumes. It re-heartbeats every
  session it holds with the same owner token. A session the daemon kept as suspect
  is restored with the same UUID. A session is lost only when the daemon says so:
  it answers that the session was released, or that another token has taken it
  over while this proxy was stalled (the session is fenced and listed in the
  handover). A daemon that does not answer any of the three attempts is stalled,
  not the proxy: those sessions are handed over as `daemon_stalled`.

After the third failed attempt the proxy hands over. It stops heartbeating the
affected sessions and returns this structured error on the next tool call that
names an affected session (or reaches it implicitly), and it sends the same body
as an MCP `notifications/message` (`level: "error"`,
`logger: "auto-mobile.liveness"`, `data: <the error body>`) so a harness that is
idle between calls is told too. The notification honours a level the client set
with `logging/setLevel`: a client that asked for `critical` or above is not sent
it and learns from the tool-call error:

```json
{
  "error": {
    "code": "daemon_stalled",
    "message": "...",
    "sessions": [
      {
        "sessionUuid": "…",
        "deviceId": "emulator-5554",
        "lastAcknowledgedHeartbeatAt": 1760000000000
      }
    ],
    "attempts": 3,
    "maxAttempts": 3,
    "lastAcknowledgedHeartbeatAt": 1760000000000,
    "retryable": true,
    "recovery": { "action": "restart_daemon_then_resume_by_session_uuid" }
  }
}
```

| Field                                    | Meaning                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`                                   | `daemon_stalled` or `proxy_stalled`.                                                                                                                                                  |
| `sessions[]`                             | `daemon_stalled`: the sessions that could not be reached. `proxy_stalled`: the sessions that were lost. Each has `sessionUuid` and `deviceId` (`null` if the proxy never learned it). |
| `sessions[].lastAcknowledgedHeartbeatAt` | When the daemon last acknowledged that session's heartbeat, in milliseconds on the proxy's clock.                                                                                     |
| `attempts`, `maxAttempts`                | Recovery attempts made (most of any listed session) and the limit, always 3.                                                                                                          |
| `lastAcknowledgedHeartbeatAt`            | The latest of the listed sessions' last acknowledgements.                                                                                                                             |
| `recovery.action`                        | `restart_daemon_then_resume_by_session_uuid` for `daemon_stalled`; `reacquire_lost_sessions` for `proxy_stalled`.                                                                     |

For `daemon_stalled` the harness restarts the daemon, then resumes each session
by passing its `sessionUuid` on a tool call: the first call after the error
re-claims it with the same owner token. For `proxy_stalled` the listed sessions and devices are gone;
reacquire them with `getAndroid` or `getApple`. During a liveness recovery episode
or while a session remains handed over, **the proxy never starts or restarts the
daemon**: it is shared, and restarting it is a harness action. Tool calls and resource reads wait for automatic recovery;
successful recovery surfaces no error, and exhausted recovery returns the structured
handover on calls/reads and by notification. Discovery does not wait for recovery or
report the handover: it serves cached/static lists when unreachable, and uncached
direct lists may observe the daemon unbound. Discovery never starts or restarts the
daemon during an episode or handover. A named resume uses an observation-only connection
and ends the handover on a definitive daemon answer: acknowledgement of the same
UUID and owner token resumes it; `daemon_session_not_found`, `liveness_owner_superseded`,
or `liveness_owner_conflict` confirms it was released or taken by another owner
after the ownership grace window. A `session-released` notification also ends it,
regardless of the current binding. A definitive loss delivers `proxy_stalled` once
on the next tool call for that session, naming the sessions and devices to
reacquire, then normal lifecycle behavior returns. An unreachable daemon retains
the handover and the no-start fence; the harness must restart it. Recovery cannot join a pending
connection allowed to start or restart the daemon. Healthy proxies and proxies
without device sessions retain normal auto-start and skew reconciliation.

A claim the daemon refuses with `liveness_owner_conflict` keeps being retried for
the other owner's lease plus its grace window (plus one heartbeat interval), so a
restarted proxy can win a session whose previous owner has gone.

## CLI session lifetime

<div class="environment-variable-table" markdown>

| Variable                                                                            | Use and accepted values                                                                    | Default     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| `AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS`, `AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS` | CLI idle leash; positive base-10 integer milliseconds. Daemon adoption clamps to one hour. | `600000` ms |

</div>

Each `--cli` invocation is its own process, so it cannot send the periodic
heartbeat a long-running MCP connection does. A session acquired or used by
`--cli` is therefore held on a wall-clock idle timeout instead of the 10 s
heartbeat contract, refreshed by every `--cli` call that touches it:

```bash
export AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS=600000
```

The default is 10 minutes, and the ceiling is 1 hour. The value is read from the
`--cli` process, not the daemon's, and travels with the invocation, so changing
it takes effect on the very next call — no daemon restart. Sessions owned by a
long-lived MCP client (stdio or HTTP) are unaffected and keep the heartbeat
contract; if such a client takes over a session a `--cli` call had held, that
session goes back to the heartbeat contract and stops occupying its device for
the idle window once the client disconnects.

## Automatic observation screenshots

<div class="environment-variable-table" markdown>

| Variable                                        | Use and accepted values                                                                                                                            | Default                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT` | Skip automatic post-action screenshots; `false` (case-insensitive, trimmed) or `0` opts into final screenshot.                                     | skip                                     |
| `AUTOMOBILE_OBSERVE_WAIT_FOR_SKIP_SCREENSHOT`   | Skip final `observe.waitFor` screenshot; `false` (case-insensitive, trimmed) or `0` enables it; intermediate polls still skip.                     | skip                                     |
| `AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT`         | Override persisted screenshot mode: `true`/`1` selects settled; any other set value selects async (case-insensitive, trimmed). Per-call mode wins. | unset; persisted flag, otherwise `async` |
| `AUTOMOBILE_MAX_OBSERVATION_AGE_MS`             | Hierarchy freshness budget; positive base-10 integer milliseconds.                                                                                 | `5000` ms                                |

</div>

Explicit `observe` calls retain their existing screenshot behavior. Automatic
observations taken after an action or while resolving `observe.waitFor` skip
screenshots by default. Opt in to one screenshot from the final result by
setting either skip flag to `false` (or `0`):

```bash
export AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT=false
export AUTOMOBILE_OBSERVE_WAIT_FOR_SKIP_SCREENSHOT=false
```

`observe.waitFor` suppresses screenshots for all intermediate polls; enabling
its flag captures only once, after the condition resolves or times out.

The default screenshot mode is `async`. Set
`AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT=true` (or `1`) to opt in to awaiting a fresh,
validated screenshot for each final observation. `false` (or `0`) disables
settled mode. This setting overrides the persisted `observe-settled-screenshot`
feature flag; when settled mode is enabled it also overrides the two legacy
skip flags. A per-call `observe({ screenshot: "settled" })` takes precedence over
both. The resolver's code comment documents the full precedence.

In a 30-iteration emulator/simulator benchmark, settled mode added about
170 ms per Android observation and 20–70 ms per iOS observation compared with
async mode. Use `observe({ screenshot: "settled" })` when a particular call needs
a validated screenshot that matches its observation.

```bash
export AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT=true
```

## Device behavior

<div class="environment-variable-table" markdown>

| Variable                                                                              | Use and accepted values                                                                                                                                          | Default                                                           |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AUTOMOBILE_IOS_WARMUP_DEVICES`                                                       | Comma-separated simulator UDIDs allowed passive startup warm-up and observation streams without sessions.                                                        | empty list                                                        |
| `AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES`                                          | Comma-separated Android serials allowed appearance sync without sessions.                                                                                        | empty list                                                        |
| `AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES`                                       | Comma-separated Android serials allowed passive observation streams without sessions.                                                                            | empty list                                                        |
| `AUTOMOBILE_APPEARANCE_SYNC`                                                          | Enable appearance sync; `0`, `false`, `off`, `no` disable (case-insensitive, trimmed).                                                                           | on                                                                |
| `AUTOMOBILE_ALLOW_DEVICE_CREATE`                                                      | Permit emulator/simulator creation; `1`/`true` enable (case-insensitive, trimmed). Explicit creation flag wins.                                                  | off                                                               |
| `AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS`, `AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS`           | Exact `0` disables session continuity; exact `1` additionally opts eligible Android emulators into active restart. Other values warn and disable active restart. | passive continuity on; active restart off                         |
| `AUTOMOBILE_ANDROID_REBOOT_ON_DEATH`, `AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH`           | Deprecated fallback for device recovery on loss, after both platform-neutral spellings; same `0`/`1` semantics.                                                  | unset                                                             |
| `AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS`, `AUTO_MOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS` | Rolling active restart budget; integer `1..10`, invalid values fall back.                                                                                        | `2`                                                               |
| `AUTOMOBILE_DEVICE_RECOVERY_WINDOW_MS`, `AUTO_MOBILE_DEVICE_RECOVERY_WINDOW_MS`       | Rolling recovery budget window; positive integer milliseconds (digits, no leading zero).                                                                         | `900000` ms                                                       |
| `AUTOMOBILE_DEVICE_POOL_MATCHING`, `AUTO_MOBILE_DEVICE_POOL_MATCHING`                 | Device selection: exact `LATEST`, `RANDOM`, `MINIMUM`; invalid values fall back.                                                                                 | `LATEST`                                                          |
| `AUTOMOBILE_DEVICE_POOL_AUTOLOCK`, `AUTO_MOBILE_DEVICE_POOL_AUTOLOCK`                 | Require acquired device session UUID and auto-release on idle; exact `1` enables.                                                                                | off                                                               |
| `AUTOMOBILE_DEVICE_POOL_TIMEOUT`, `AUTO_MOBILE_DEVICE_POOL_TIMEOUT`                   | Autolock idle timeout in **seconds**, parsed as a positive base-10 integer prefix.                                                                               | `60` seconds                                                      |
| `AUTOMOBILE_EMULATOR_HEADLESS`                                                        | Exact `true` forces headless, `false` forces windowed; other values use platform detection.                                                                      | headless on macOS and Linux without a display; otherwise windowed |
| `AUTOMOBILE_EMULATOR_AUDIO`                                                           | Exact `false` adds `-no-audio`; other values keep emulator audio.                                                                                                | audio on                                                          |
| `AUTOMOBILE_EMULATOR_ARGS`                                                            | Extra emulator argv as a JSON array of nonempty strings; malformed JSON/entries fail.                                                                            | empty array                                                       |
| `AUTOMOBILE_IOS_HEADLESS`                                                             | On macOS exact `true`/`1` forces headless; any other set value forces windowed. Non-macOS is always headless.                                                    | detect graphical login session                                    |
| `AUTOMOBILE_WORK_PROFILE_POLL_INTERVAL_MS`                                            | Android work-profile package polling interval; base-10 integer milliseconds. Use positive values; this read has no invalid-value fallback.                       | `5000` ms                                                         |

</div>

The daemon's passive device work is limited to devices with a session in this
daemon. At startup, it warms iOS CtrlProxy only for rehydrated sessions. An
explicit acquisition can also start a runner for its device. Previously an unset
`AUTOMOBILE_IOS_WARMUP_DEVICES` warmed every booted simulator; now unset or
empty means no extra simulators. Set it to a comma-separated list of simulator
UDIDs to allow iOS startup warm-up and observation-stream connections for those
devices even without a session. The live-acceptance startup secret suppresses
both iOS passive paths, including allowlisted devices.

```bash
export AUTOMOBILE_IOS_WARMUP_DEVICES=00000000-0000-0000-0000-000000000001
```

Android appearance sync also defaults to session-owned devices. It runs when a
session acquires a device and on later scheduler ticks. IDE-only use without a
session no longer syncs appearance unless the device serial is in
`AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES`. Set `AUTOMOBILE_APPEARANCE_SYNC` to
`0`, `false`, `off`, or `no` (case-insensitive, with surrounding whitespace
ignored) to turn off appearance sync in daemon and direct mode. Android
observation-stream initial connections and cadence refreshes follow the same
session-owned default; use
`AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES` to opt in unowned serials.
These Android settings do not affect iOS warm-up. Each device list is a
comma-separated list of IDs; an empty value adds no devices.

```bash
export AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES=emulator-5554
export AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES=emulator-5554
```

AutoMobile does not create an emulator or simulator by default. The legacy
compatibility path can opt in:

```bash
export AUTOMOBILE_ALLOW_DEVICE_CREATE=1
auto-mobile --cli startDevice --platform ios --create-if-missing
```

An explicit `--create-if-missing false` disables creation even when the
environment variable is set. Created devices can be removed with
`xcrun simctl delete <udid>` or `avdmanager delete avd -n <name>`.

Session continuity is enabled by default for any session bound to an Android
emulator or iOS simulator, regardless of how that binding happened -- an
explicit `startDevice`/`getAndroid`, or a client-supplied or runner-minted
session UUID that the daemon allocated from the idle pool. What matters is
whether discovery resolved a stable identity for the device (its AVD name, or
its simulator UDID), not who launched it. If the runtime connection
disappears, AutoMobile retains the session for that stable identity and waits
for it to reappear. To disable that continuity explicitly:

```bash
export AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS=0
export AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS=2
```

Actively restarting the AVD process on loss is a stricter, separate opt-in:
`AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS=1` additionally requires the emulator's
configured image to have been recorded, which only happens on a
`startDevice`/`getAndroid` path with successful image enrichment. A pool-
allocated or enrichment-failed emulator still gets passive continuity
(reattach when it returns) but is never actively relaunched. Physical devices
and externally started Android emulators are not restarted. iOS simulators are
never actively restarted by session continuity; their recovery is always
passive, waiting for the same simulator UDID to become booted again.

`AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS` is a rolling budget, not a lifetime
one: only restarts within the last `AUTOMOBILE_DEVICE_RECOVERY_WINDOW_MS`
(default 15 minutes) count against it, so isolated crashes days apart don't
exhaust the budget of a long-lived daemon. A recovery cancelled before it
touches the emulator (an ADB-reset takeover, or an intentional `killDevice`)
does not spend an attempt either way.

## Shared ADB server

<div class="environment-variable-table" markdown>

| Variable                                                          | Use and accepted values                                                                                                | Default |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| `AUTOMOBILE_MANAGED_ADB_SERVER`, `AUTO_MOBILE_MANAGED_ADB_SERVER` | Declare process ownership of ADB server; `1`/`true` enable (case-insensitive, trimmed), stopping it on clean shutdown. | off     |

</div>

By default AutoMobile leaves the local ADB server running. Set
`AUTOMOBILE_MANAGED_ADB_SERVER=1` only when this process owns the server; a
clean shutdown then stops it after active device sessions are released.

## Port allocation

<div class="environment-variable-table" markdown>

| Variable                                                      | Use and accepted values                                                                                                                    | Default |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `AUTOMOBILE_PORT_RANGE_START`, `AUTO_MOBILE_PORT_RANGE_START` | First CtrlProxy host port; positive base-10 integer.                                                                                       | `8765`  |
| `AUTOMOBILE_PORT_RANGE_END`, `AUTO_MOBILE_PORT_RANGE_END`     | Inclusive last CtrlProxy host port; base-10 integer at least the start. Takes precedence over size; invalid values fall back to 100 ports. | unset   |
| `AUTOMOBILE_PORT_RANGE_SIZE`, `AUTO_MOBILE_PORT_RANGE_SIZE`   | Number of CtrlProxy host ports; positive base-10 integer, used only without end.                                                           | `100`   |

</div>

## Assets and CtrlProxy

<div class="environment-variable-table" markdown>

| Variable                                                                                     | Use and accepted values                                                                                                                               | Default                                                   |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `AUTOMOBILE_VERSION`                                                                         | Trimmed concrete asset release version; unset, empty or `latest` uses newest registry release. Unknown explicit pins fail closed on integrity checks. | newest release registry entry                             |
| `AUTOMOBILE_ASSET_BASE_URL`                                                                  | Release asset mirror base; absolute HTTPS URL without query or fragment, trailing slash removed.                                                      | `https://github.com/kaeawc/auto-mobile/releases/download` |
| `AUTOMOBILE_ALLOW_INSECURE_ASSET_URL`                                                        | Permit plaintext HTTP asset URLs with `1`/`true` (case-insensitive, no trimming); other non-HTTPS schemes still fail.                                 | off                                                       |
| `AUTOMOBILE_CTRL_PROXY_APK_PATH`                                                             | Local Android APK override; trimmed filesystem path, resolved from daemon launch directory; bypasses published APK checksum baseline.                 | released/cached APK                                       |
| `AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM`, `AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK` | Skip Android APK checksum enforcement with `1`/`true` (case-insensitive, no trimming).                                                                | off                                                       |
| `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED`                                        | Skip APK download when already installed; `1`/`true` enables (case-insensitive, no trimming).                                                         | off                                                       |
| `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD`                                                        | Use local CtrlProxy sources without downloading; `1`/`true` enables (case-insensitive, no trimming); CLI skip flag also enables.                      | off                                                       |
| `AUTOMOBILE_CTRLPROXY_VERBOSE`                                                               | Verbose iOS CtrlProxy output; exact `true` enables.                                                                                                   | off                                                       |
| `AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS`, `AUTO_MOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS`    | iOS runner health poll attempts; positive base-10 integer.                                                                                            | `60`                                                      |
| `AUTOMOBILE_IPROXY_START_TIMEOUT_MS`, `AUTO_MOBILE_IPROXY_START_TIMEOUT_MS`                  | iOS USB iproxy tunnel startup timeout; positive base-10 integer milliseconds.                                                                         | `5000` ms                                                 |
| `AUTOMOBILE_CWEBP_PATH`                                                                      | Trusted executable cwebp override; trimmed filesystem path; invalid executable fails.                                                                 | PATH, bundled vendor or downloaded libwebp                |
| `AUTOMOBILE_DWEBP_PATH`                                                                      | Trusted executable dwebp override; trimmed filesystem path; invalid executable fails.                                                                 | PATH, bundled vendor or downloaded libwebp                |
| `AUTOMOBILE_FFMPEG`                                                                          | ffmpeg executable override; executable path/name (not trimmed); explicit resolver option wins.                                                        | `ffmpeg` on PATH                                          |

</div>

## iOS builds and signing

<div class="environment-variable-table" markdown>

| Variable                                         | Use and accepted values                                                                                                                                | Default                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `AUTOMOBILE_PROJECT_ROOT`                        | Root used by local iOS CtrlProxy source builds; filesystem path.                                                                                       | process working directory at module load     |
| `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA`         | Local iOS CtrlProxy derived-data root; filesystem path.                                                                                                | data directory `derived-data`                |
| `AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR`            | iOS CtrlProxy bundle cache directory; filesystem path.                                                                                                 | coordination directory `ctrl-proxy-ios`      |
| `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL`           | Trimmed custom iOS bundle download URL; HTTPS unless insecure asset URL opt-in.                                                                        | release bundle URL                           |
| `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`             | Trimmed local iOS archive/bundle override; filesystem path; wins over bundle-path override.                                                            | unset; released bundle                       |
| `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`          | Trimmed local iOS runner bundle or archive override; filesystem path.                                                                                  | unset; released bundle                       |
| `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256`        | Trimmed 64-character hexadecimal executable SHA256 for local/custom runner; wins over local-build derivation.                                          | release registry checksum                    |
| `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET` | Checksum executable: exact trimmed `runner` or `xctest`; other nonempty values fail.                                                                   | release registry target                      |
| `AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD`      | Derive and pin local runner executable hash after build/extract, then reverify before launch; `1`/`true` enables (case-insensitive, no trimming).      | off                                          |
| `AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH`             | Trimmed expected device app bundle hash; device-specific override wins.                                                                                | released device app hash                     |
| `AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_DEVICE`      | Trimmed expected device app bundle hash; overrides generic/device release hash.                                                                        | generic override or released device app hash |
| `AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_SIMULATOR`   | Trimmed expected simulator app bundle hash.                                                                                                            | unset; no simulator app hash verification    |
| `AUTOMOBILE_IOS_SKIP_CTRL_PROXY_APP_HASH`        | Skip iOS app bundle hash enforcement; exact `true`/`1` enables.                                                                                        | off                                          |
| `AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN`         | Make codesign, Gatekeeper or pinned Team ID failures fatal; `1`/`true` enables (case-insensitive, no trimming).                                        | off; failures warn                           |
| `AUTOMOBILE_IOS_HELPER_TEAM_ID`                  | Trimmed Apple Team ID to verify on downloaded runner bundle; warn or refuse according to require-codesign.                                             | unset                                        |
| `AUTOMOBILE_IOS_TEAM_IDS`                        | Comma-separated signing Team IDs, trimmed; wins over single Team ID.                                                                                   | auto-detected signing teams                  |
| `AUTOMOBILE_IOS_TEAM_ID`                         | Single signing Team ID, also parsed as a comma-separated list; used without plural setting.                                                            | auto-detected signing teams                  |
| `AUTOMOBILE_IOS_PROFILE_UUID`                    | Provisioning profile UUID; wins over name and specifier.                                                                                               | automatic profile discovery                  |
| `AUTOMOBILE_IOS_PROFILE_NAME`                    | Provisioning profile name; used without UUID, wins over specifier.                                                                                     | automatic profile discovery                  |
| `AUTOMOBILE_IOS_PROFILE_SPECIFIER`               | Provisioning profile specifier; used without UUID or name.                                                                                             | automatic profile discovery                  |
| `AUTOMOBILE_IOS_CODE_SIGN_IDENTITY`              | Trimmed signing identity string.                                                                                                                       | auto-detected identity                       |
| `AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH`     | Entitlements file path for signing; filesystem path.                                                                                                   | runner/app entitlements discovery            |
| `AUTOMOBILE_IOS_TAP_STRATEGY`                    | Diagnostic tap strategy (only at debug log level): exact `legacy`, `appRelative`, `appRelativeObserved`, `displayTargeted`, `displayTargetedObserved`. | runner default strategy                      |

</div>

## Video recording and capture

<div class="environment-variable-table" markdown>

| Variable                                                                                  | Use and accepted values                                                                                                                                                                                       | Default                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `AUTOMOBILE_VIDEO_QUALITY_PRESET`, `AUTO_MOBILE_VIDEO_QUALITY_PRESET`                     | Exact `low`, `medium`, `high` recording preset; CLI and per-call options win.                                                                                                                                 | `low`                                      |
| `AUTOMOBILE_VIDEO_TARGET_BITRATE_KBPS`, `AUTO_MOBILE_VIDEO_TARGET_BITRATE_KBPS`           | Positive base-10 integer prefix via `parseInt(value, 10)` in kbps (`999.9` becomes `999`, `29abc` becomes `29`); invalid/nonpositive values warn and are ignored; empty ignored. Throughput cap may lower it. | `1000` kbps                                |
| `AUTOMOBILE_VIDEO_MAX_THROUGHPUT_MBPS`, `AUTO_MOBILE_VIDEO_MAX_THROUGHPUT_MBPS`           | Positive finite `Number(value)` (fractions allowed, trailing junk rejected), recording throughput cap; invalid/nonpositive values warn and are ignored; empty ignored.                                        | `5` Mbps                                   |
| `AUTOMOBILE_VIDEO_FPS`, `AUTO_MOBILE_VIDEO_FPS`                                           | Positive base-10 integer prefix via `parseInt(value, 10)` in frames/second (`29.9` or `29abc` becomes `29`); invalid/nonpositive values warn and are ignored; empty ignored. Backend may clamp.               | `15` fps                                   |
| `AUTOMOBILE_VIDEO_MAX_ARCHIVE_MB`, `AUTO_MOBILE_VIDEO_MAX_ARCHIVE_MB`                     | Positive finite `Number(value)` (fractions allowed, trailing junk rejected), archive storage limit; invalid/nonpositive values warn and are ignored; empty ignored.                                           | `100` MB                                   |
| `AUTOMOBILE_VIDEO_FORMAT`, `AUTO_MOBILE_VIDEO_FORMAT`                                     | Exact `mp4`; other values warn and are ignored.                                                                                                                                                               | `mp4`                                      |
| `AUTOMOBILE_VIDEO_RETENTION_DAYS`, `AUTO_MOBILE_VIDEO_RETENTION_DAYS`                     | Finite nonnegative recording TTL in days; `0` disables age expiry.                                                                                                                                            | `7` days                                   |
| `AUTOMOBILE_VIDEO_RETENTION_SWEEP_MINUTES`, `AUTO_MOBILE_VIDEO_RETENTION_SWEEP_MINUTES`   | Positive finite sweep period in minutes; timer minimum 1 second.                                                                                                                                              | `60` minutes                               |
| `AUTOMOBILE_VIDEO_INPROGRESS_CHECK_SECONDS`, `AUTO_MOBILE_VIDEO_INPROGRESS_CHECK_SECONDS` | Positive finite active recording size-check period in seconds; timer minimum 1 second.                                                                                                                        | `15` seconds                               |
| `AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE`                                                | Android exec-out screenrecord to ffmpeg recording backend; exact `1`/`true` enables.                                                                                                                          | off                                        |
| `AUTOMOBILE_VIDEO_SERVER_JAR`                                                             | Local Android persistent encoder JAR; untrimmed filesystem path, used only if it exists. Surrounding whitespace is significant; nonexistent paths silently fall through.                                      | cached/released JAR, then source-built JAR |
| `AUTOMOBILE_REQUIRE_VIDEO_SERVER`                                                         | Make unavailable/invalid video-server JAR fatal instead of degrading; `1`/`true` enables (case-insensitive, no trimming).                                                                                     | off                                        |
| `AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD`                                                   | Resolve video-server JAR locally only; `1`/`true` enables (case-insensitive, no trimming).                                                                                                                    | off                                        |
| `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER`, `AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER`           | Local screen-capture-helper executable path; bypasses release prefetch.                                                                                                                                       | released helper                            |
| `AUTOMOBILE_IOS_WEBRTC_FFMPEG`, `AUTO_MOBILE_IOS_WEBRTC_FFMPEG`                           | iOS WebRTC ffmpeg executable path/name (not trimmed); first nonempty spelling wins; explicit resolver option wins.                                                                                            | `ffmpeg` on PATH                           |
| `AUTOMOBILE_IOS_WEBRTC_FORCE_RAW`, `AUTO_MOBILE_IOS_WEBRTC_FORCE_RAW`                     | Force raw iOS capture path instead of native H.264; `1`/`true` enables (case-insensitive, no trimming).                                                                                                       | off                                        |
| `AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS`                                              | Simulator capture window target resolution budget; positive base-10 integer milliseconds.                                                                                                                     | `2000` ms                                  |

</div>

## WebRTC

<div class="environment-variable-table" markdown>

| Variable                                 | Use and accepted values                                                                                                                | Default                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT`        | WHIP ingest URL; HTTPS, or loopback HTTP; remote HTTP requires insecure-WHIP opt-in. Per-call options win.                             | unset; required to stream                                  |
| `AUTOMOBILE_WEBRTC_WHIP_TOKEN`           | Bearer token string for WHIP ingest.                                                                                                   | unset                                                      |
| `AUTOMOBILE_WEBRTC_ICE_SERVERS`          | JSON array of RTCIceServer objects (`urls`, optional `username`/`credential`) or comma-separated STUN/TURN URLs.                       | `stun:stun.l.google.com:19302`                             |
| `AUTOMOBILE_WEBRTC_BITRATE_KBPS`         | Positive finite encoder bitrate, rounded to integer kbps.                                                                              | unset; encoder/source default (iOS uses pixel-rate budget) |
| `AUTOMOBILE_WEBRTC_MAX_SIZE`             | `WIDTHxHEIGHT`; positive even safe integers within H.264 Level 4.2 frame limit.                                                        | unset; source dimensions                                   |
| `AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS`    | Integer `5..60` capture rate.                                                                                                          | `15` fps                                                   |
| `AUTOMOBILE_WEBRTC_ANDROID_FPS`          | Integer `1..60` capture rate.                                                                                                          | `30` fps                                                   |
| `AUTOMOBILE_WEBRTC_TRICKLE_ICE`          | WHIP PATCH trickle ICE; `1`, `true`, `yes`, `on` enable (case-insensitive, trimmed).                                                   | off                                                        |
| `AUTOMOBILE_WEBRTC_AUDIO`                | Add audio track; `1`, `true`, `yes`, `on` enable (case-insensitive, trimmed).                                                          | off                                                        |
| `AUTOMOBILE_WEBRTC_ALLOW_INSECURE_WHIP`  | Permit non-loopback HTTP and arbitrary wire WHIP overrides; `1`, `true`, `yes`, `on` enable (case-insensitive, trimmed).               | off                                                        |
| `AUTOMOBILE_WEBRTC_WHIP_ALLOWED_ORIGINS` | Comma-separated origins or bare `host[:port]` allowed for wire WHIP overrides; loopback and configured WHIP origin are always trusted. | empty additional allowlist                                 |

</div>

## Navigation retention

<div class="environment-variable-table" markdown>

| Variable                                            | Use and accepted values                                                                                    | Default                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------- |
| `AUTOMOBILE_NAV_RETENTION_SCREENSHOT_TTL_MS`        | Screenshot retention TTL; positive safe integer milliseconds.                                              | `604800000` ms (7 days)   |
| `AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS`         | Structure retention TTL; positive safe integer milliseconds.                                               | `7776000000` ms (90 days) |
| `AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS` | Per-app observation cap; positive safe integer.                                                            | `50000`                   |
| `AUTOMOBILE_NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS`  | Global observation cap; positive safe integer.                                                             | `500000`                  |
| `AUTOMOBILE_NAV_RETENTION_EVICTION_CHUNK_SIZE`      | Rows per eviction batch; positive safe integer clamped to `10000`.                                         | `5000`                    |
| `AUTOMOBILE_NAV_RETENTION_INTERVAL_MS`              | Retention sweep cadence; positive safe integer milliseconds at most `2147483647`; larger values fall back. | `21600000` ms (6 hours)   |

</div>

## Performance diagnostics

<div class="environment-variable-table" markdown>

| Variable                                                                  | Use and accepted values                                                                                                                 | Default   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `AUTOMOBILE_OBSERVE_PERF_SNAPSHOT`, `AUTO_MOBILE_OBSERVE_PERF_SNAPSHOT`   | Attach rolling performance snapshot to observe results; `1`, `true`, `yes` enable (case-insensitive, trimmed).                          | off       |
| `AUTOMOBILE_OBSERVE_PERF_WINDOW_MS`, `AUTO_MOBILE_OBSERVE_PERF_WINDOW_MS` | Positive finite snapshot window milliseconds, rounded and clamped to `1000..30000`; invalid values fall back.                           | `5000` ms |
| `AUTOMOBILE_DISABLE_PERF_AUDIT`                                           | Disable UI performance audit with `1`, `true`, `yes` (case-insensitive, trimmed); audit otherwise requires UI perf mode and debug-perf. | off       |
| `AUTOMOBILE_TOUCH_LATENCY_SAMPLING`                                       | Opt into synthetic tap latency sampling; `1`, `true`, `yes` enables (case-insensitive, trimmed).                                        | off       |

</div>
