# Environment Variables

Most users can use the defaults. Set these variables when you need a different
state directory, logs, tool set, or device behavior.

## State and logs

<div class="environment-variable-table" markdown>

| Variable                      | Use                                                                                                                                         | Default                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `AUTOMOBILE_DATA_DIR`         | Base directory for observe, accessibility, navigation, CtrlProxy-build, screen-streaming, WebRTC, tool-output, and daemon-failure artifacts | `~/.auto-mobile`               |
| `AUTOMOBILE_LOG_DIR`          | Directory for daemon and client logs                                                                                                        | `~/.auto-mobile/logs`          |
| `AUTOMOBILE_LOG_FORMAT`       | `text` or newline-delimited `json`                                                                                                          | `text`                         |
| `AUTOMOBILE_LOG_SINK`         | `file`, `stderr`, or `both`                                                                                                                 | `file`                         |
| `AUTOMOBILE_COORDINATION_DIR` | Absolute, shared directory for cross-process CtrlProxy forwarding leases                                                                    | OS account home `.auto-mobile` |

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

| Variable             | Use                                   | Default                         |
| -------------------- | ------------------------------------- | ------------------------------- |
| `AUTOMOBILE_DB_PATH` | Exact SQLite database path            | `~/.auto-mobile/auto-mobile.db` |
| `AUTOMOBILE_DB_DIR`  | Directory containing `auto-mobile.db` | unset                           |

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

```bash
export AUTOMOBILE_ENABLED_TOOLS=clipboard,sqlQuery
export AUTOMOBILE_DISABLED_TOOLS=observe
```

Tool names are exact and case-sensitive. Unknown names and same-layer
enable/disable conflicts fail startup. Repeatable `--enable-tool` and
`--disable-tool` flags override these environment values; persisted
`setToolEnabled` choices override startup defaults.

## Session heartbeat timeout

`AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS` (alias
`AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS`) defaults to `10000` ms. It controls
the heartbeat leash for heartbeat-policy sessions, not `cli-idle` sessions.
The proxy's default heartbeat cadence derives from this timeout.

```bash
export AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS=20000
```

## CLI session lifetime

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

By default AutoMobile leaves the local ADB server running. Set
`AUTOMOBILE_MANAGED_ADB_SERVER=1` only when this process owns the server; a
clean shutdown then stops it after active device sessions are released.

The preferred `AUTOMOBILE_*` spelling is documented here. Older
`AUTO_MOBILE_*` aliases are accepted for the state, log, database, recovery,
and ADB settings when the preferred name is unset.
