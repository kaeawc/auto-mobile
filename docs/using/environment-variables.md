# Environment Variables

Most users can use the defaults. Set these variables when you need a different
state directory, logs, tool set, or device behavior.

Each name below with an `AUTO_MOBILE_` spelling is a legacy alias; when a cell
lists two names, the first takes precedence when set. Defaults are the behavior
with the variable unset. A flag whose row says `1`/`true` accepts `1`, `true`,
`yes` or `on`, trimmed and case-insensitive; any other value is off. A row that
says _exact_ accepts only the values it shows. Unknown numeric values usually
fall back to the default unless the row says otherwise.

## State and logs

<div class="environment-variable-table" markdown>

| Variable                                                                            | Use and accepted values                                                                                                                                                                                                  | Default                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `AUTOMOBILE_DATA_DIR`, `AUTO_MOBILE_DATA_DIR`                                       | Base directory for observations, navigation data, CtrlProxy builds, streaming, tool outputs and downloaded tools; filesystem path, relative to the daemon launch directory.                                              | `~/.auto-mobile` (OS temp fallback if home is unavailable) |
| `AUTOMOBILE_LOG_DIR`, `AUTO_MOBILE_LOG_DIR`                                         | Daemon and client log directory; filesystem path.                                                                                                                                                                        | `$AUTOMOBILE_DATA_DIR/logs`                                |
| `AUTOMOBILE_PLAN_HEALTH_DIR`                                                        | Each `executePlan` run writes a JSON health summary (per-tool step latency, failures, skips) here and attaches it as `healthSummary` in the result; filesystem path.                                                     | unset (no summary)                                         |
| `AUTOMOBILE_LOG_FORMAT`, `AUTO_MOBILE_LOG_FORMAT`                                   | Log format: `text` or newline-delimited `json`.                                                                                                                                                                          | `text`                                                     |
| `AUTOMOBILE_LOG_SINK`, `AUTO_MOBILE_LOG_SINK`                                       | Log destination: `file`, `stderr`, `both`.                                                                                                                                                                               | `file`                                                     |
| `AUTOMOBILE_LOG_LEVEL`, `AUTO_MOBILE_LOG_LEVEL`                                     | Logging threshold: `debug`, `info`, `warn`/`warning`, `error`, `none`/`silent`.                                                                                                                                          | `info`                                                     |
| `AUTOMOBILE_COORDINATION_DIR`, `AUTO_MOBILE_COORDINATION_DIR`                       | Shared directory for coordination between AutoMobile agents, including the iOS CtrlProxy bundle cache and signing entitlements; absolute path shared by cooperating agents. Set it when the home directory is read-only. | OS account home `.auto-mobile`                             |
| `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR`, `AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR` | Directory where daemons sharing one ADB server record device claims and emulator boots; absolute path, the same for every daemon on that server.                                                                         | OS account home `.auto-mobile/adb-servers`                 |
| `AUTOMOBILE_TOOL_OUTPUTS_DIR`, `AUTO_MOBILE_TOOL_OUTPUTS_DIR`                       | Directory for large CLI tool-output files; filesystem path. CLI `--tool-outputs-dir` wins.                                                                                                                               | data directory `tool_outputs`                              |
| `AUTOMOBILE_DEBUG`                                                                  | CLI debug logging; `1`/`true` enables. Also attaches an input-method commit trace to `sendKeys` results as `imeTrace` when the device supports it.                                                                       | off                                                        |
| `AUTOMOBILE_DEBUG_PERF`                                                             | UI performance debug tracking; `1`/`true` enables (also `--debug-perf`/`--ui-perf-debug`).                                                                                                                               | off                                                        |
| `AUTOMOBILE_DOCTOR_TIMEOUT_MS`                                                      | `doctor` command timeout; positive integer milliseconds. Anything else is ignored with a warning.                                                                                                                        | `5000` ms                                                  |

</div>

For container log collection:

```bash
export AUTOMOBILE_DATA_DIR=/var/lib/automobile
export AUTOMOBILE_LOG_FORMAT=json
export AUTOMOBILE_LOG_SINK=stderr
# The container's only daemon uses this data dir; see "Shared-namespace guard" below.
export AUTOMOBILE_ALLOW_SHARED_DAEMON_NAMESPACE=1
```

`AUTOMOBILE_DATA_DIR` does not move the SQLite database (`AUTOMOBILE_DB_DIR` /
`AUTOMOBILE_DB_PATH`), auxiliary daemon sockets (`AUTOMOBILE_AUX_SOCKET_DIR`), or
coordination directories. Set `AUTOMOBILE_COORDINATION_DIR` to move coordination
state. The iOS bundle cache can also be moved with
`AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR`.

## Daemon namespace

<div class="environment-variable-table" markdown>

| Variable                                                                                                    | Use and accepted values                                                                                                                                                                                                                                       | Default                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `AUTOMOBILE_DAEMON_SOCKET_PATH`, `AUTO_MOBILE_DAEMON_SOCKET_PATH`                                           | Daemon control socket; filesystem path.                                                                                                                                                                                                                       | `/tmp/auto-mobile-daemon-<uid>.sock`            |
| `AUTOMOBILE_DAEMON_PID_FILE_PATH`, `AUTO_MOBILE_DAEMON_PID_FILE_PATH`                                       | Daemon PID record; filesystem path.                                                                                                                                                                                                                           | `/tmp/auto-mobile-daemon-<uid>.pid`             |
| `AUTOMOBILE_DAEMON_LOCK_FILE_PATH`, `AUTO_MOBILE_DAEMON_LOCK_FILE_PATH`                                     | Daemon start lock; filesystem path.                                                                                                                                                                                                                           | `/tmp/auto-mobile-daemon-<uid>.lock`            |
| `AUTOMOBILE_DAEMON_TOKEN_FILE_PATH`                                                                         | Daemon HTTP token file (mode 0600) that clients read to authenticate; filesystem path.                                                                                                                                                                        | `/tmp/auto-mobile-daemon-<uid>.token`           |
| `AUTOMOBILE_DAEMON_HTTP_TOKEN`                                                                              | Client-side: the daemon HTTP bearer token to send instead of reading the token file.                                                                                                                                                                          | unset                                           |
| `AUTOMOBILE_AUX_SOCKET_DIR`                                                                                 | Directory for auxiliary stream sockets; filesystem path. When set, the control socket, PID and lock files also move to a per-directory name, so a second daemon never touches the default daemon's files (an explicit `AUTOMOBILE_DAEMON_*_PATH` still wins). | `~/.auto-mobile`                                |
| `AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH`, `AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH`                             | WebRTC stream socket; filesystem path.                                                                                                                                                                                                                        | auxiliary socket directory `webrtc-stream.sock` |
| `AUTOMOBILE_DAEMON_TIMEOUT_MS`, `AUTO_MOBILE_DAEMON_TIMEOUT_MS`                                             | Connection and request timeout; positive integer milliseconds.                                                                                                                                                                                                | `120000` ms                                     |
| `AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS`, `AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS`                             | Cold startup budget; positive integer milliseconds, capped at `2147483647`.                                                                                                                                                                                   | `30000` ms                                      |
| `AUTOMOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS`, `AUTO_MOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS` | How long to wait for an already-running daemon to answer; positive integer milliseconds, capped at two-thirds of the startup budget.                                                                                                                          | `10000` ms, subject to cap                      |
| `AUTOMOBILE_DAEMON_DISABLE_HANDSHAKE`, `AUTO_MOBILE_DAEMON_DISABLE_HANDSHAKE`                               | Disable the version and build handshake with the daemon; `1`/`true` disables.                                                                                                                                                                                 | off; handshake enabled                          |
| `AUTOMOBILE_DAEMON_STREAM_AUTH`                                                                             | Require session authentication on video and WebRTC sockets; `0`, `false`, `no`, `off` disable.                                                                                                                                                                | on                                              |
| `AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS`, `AUTO_MOBILE_OPEN_LINK_MCP_TIMEOUT_MS`                               | `openLink` time budget; positive integer milliseconds. Set it in the daemon environment (the daemon wins if both client and daemon set it).                                                                                                                   | `90000` ms                                      |
| `AUTOMOBILE_OBSERVE_MCP_TIMEOUT_MS`, `AUTO_MOBILE_OBSERVE_MCP_TIMEOUT_MS`                                   | `observe` time budget; same rules as `openLink`.                                                                                                                                                                                                              | `90000` ms                                      |
| `AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS`, `AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS`                         | CtrlProxy readiness timeout; integer milliseconds in `1000..120000`. CLI flag wins.                                                                                                                                                                           | `30000` ms                                      |
| `AUTOMOBILE_CTRL_PROXY_LEASE_IDLE_MS`                                                                       | Idle time after which the daemon closes a device's CtrlProxy connection and releases its port forwarding; positive integer milliseconds.                                                                                                                      | `60000` ms                                      |
| `AUTOMOBILE_ALLOW_SHARED_DAEMON_NAMESPACE`                                                                  | Let daemon lifecycle commands and automatic client restarts act on the default daemon while a state directory is relocated (see "Shared-namespace guard"); exact `1` enables.                                                                                 | unset                                           |

</div>

Set `AUTOMOBILE_DAEMON_SOCKET_PATH`, `AUTOMOBILE_DAEMON_PID_FILE_PATH`, and
`AUTOMOBILE_DAEMON_LOCK_FILE_PATH` to distinct absolute paths for each concurrent
instance. Relative paths resolve from the daemon launch directory.

### Shared-namespace guard

`AUTOMOBILE_DATA_DIR`, `AUTOMOBILE_DB_DIR` and `AUTOMOBILE_DB_PATH` relocate a
daemon's state, but not its socket. With any of them set and neither
`AUTOMOBILE_AUX_SOCKET_DIR` nor a non-default `AUTOMOBILE_DAEMON_SOCKET_PATH`,
`--daemon start`, `stop`, `restart` and `release-session` refuse with
`[shared_daemon_namespace]`, because they would act on the default daemon, which
runs on different state. MCP and `--cli` clients likewise refuse an automatic
restart, though they still start a daemon when none is running.
`AUTOMOBILE_LOG_DIR` and the coordination directories do not count.

Set `AUTOMOBILE_AUX_SOCKET_DIR` to use a separate daemon instead. To act on the
default daemon deliberately, pass `--allow-shared-namespace` after the daemon
command, or set `AUTOMOBILE_ALLOW_SHARED_DAEMON_NAMESPACE=1` on hosts whose only
daemon uses the relocated state, such as a container.

A daemon that exits on its own is replaced with the same port and startup flags.
The replacement runs with the new client's environment, so environment-only
settings follow the new client. Run `--daemon stop` first for a fresh set of
flags.

## Database

<div class="environment-variable-table" markdown>

| Variable                                                                        | Use and accepted values                                                                                                        | Default                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `AUTOMOBILE_DB_PATH`, `AUTO_MOBILE_DB_PATH`                                     | Exact SQLite database file; filesystem path. Takes precedence over the DB directory.                                           | `~/.auto-mobile/auto-mobile.db`         |
| `AUTOMOBILE_DB_DIR`, `AUTO_MOBILE_DB_DIR`                                       | Directory containing `auto-mobile.db`; filesystem path.                                                                        | `~/.auto-mobile`                        |
| `AUTOMOBILE_MIGRATIONS_DIR`, `AUTO_MOBILE_MIGRATIONS_DIR`                       | Directory of migration modules; filesystem path.                                                                               | bundled migrations                      |
| `AUTOMOBILE_MIGRATION_RECOVERY`, `AUTO_MOBILE_MIGRATION_RECOVERY`               | Safe migration-history recovery is on unless `0`, `false`, `no`, `off`. Only exact `1` also permits a destructive table reset. | safe recovery on; destructive reset off |
| `AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS`, `AUTO_MOBILE_MIGRATION_LOCK_TIMEOUT_MS` | How long to wait for the migration lock; positive integer milliseconds.                                                        | `60000` ms                              |

</div>

Relative paths resolve from the daemon's launch directory. Use a path unique to
each concurrent instance:

```bash
export AUTOMOBILE_DB_PATH="$PWD/.auto-mobile/auto-mobile.db"
```

## Tool defaults

<div class="environment-variable-table" markdown>

| Variable                                        | Use and accepted values                                                                                               | Default    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| `AUTOMOBILE_ENABLED_TOOLS`                      | Comma-separated tool names to enable; exact, case-sensitive. Unknown names and enable/disable conflicts fail startup. | unset      |
| `AUTOMOBILE_DISABLED_TOOLS`                     | Comma-separated tool names to disable; same rules.                                                                    | unset      |
| `AUTOMOBILE_ALWAYS_LOAD_TOOLS`                  | Register optional tool definitions up front; `1`/`true` enables.                                                      | off        |
| `AUTOMOBILE_OBSERVE_RESULT_INCLUDE_ELEMENTS`    | Include a flattened `elements` list in observations; exact `1` enables, or the matching CLI flag.                     | off        |
| `AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT` | Omit structured tool content; exact `1` enables, or the matching CLI flag.                                            | off        |
| `AUTOMOBILE_ACTIONS_DIFF_OBSERVE`               | Return differential observations after actions; exact `1` enables, or the matching CLI flag.                          | off        |
| `AUTOMOBILE_ACTIONS_NO_OBSERVE`                 | Skip the observation after actions; exact `1` enables, or the matching CLI flag.                                      | off        |
| `AUTOMOBILE_ACTIONS_COMPACT_METADATA`           | Omit unchanged metadata and duplicate matches from action results; exact `0` opts out, `1` opts in. CLI flags win.    | on         |
| `AUTOMOBILE_EVENT_ALL_MARKERS`                  | Comma-separated event markers that switch capture to all events; `--event-all-markers` wins.                          | empty list |

</div>

```bash
export AUTOMOBILE_ENABLED_TOOLS=clipboard,sqlQuery
export AUTOMOBILE_DISABLED_TOOLS=observe
```

Repeatable `--enable-tool` and `--disable-tool` flags override these values, and
`setToolEnabled` choices override startup defaults.

## Experimental session broker

<div class="environment-variable-table" markdown>

| Variable                           | Use and accepted values                                                                                                                                                        | Default                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `AUTOMOBILE_SESSION_BROKER_CONFIG` | Path to a JSON configuration file, relative to the daemon launch directory. Enables the experimental session-only broker and supplies its capacity limits and device defaults. | unset; ordinary daemon mode |
| `AUTOMOBILE_SESSION_CONFIG`        | A session request as inline JSON or a JSON file path. `--session-config` takes precedence. Cannot be combined with `--initial-session-uuid` or `--no-proxy`.                   | unset; ordinary proxy mode  |

</div>

See [the session broker experiment](../design-docs/session-broker-experiment.md)
for the file formats.

## Session heartbeat timeout

<div class="environment-variable-table" markdown>

| Variable                                                                                              | Use and accepted values                                                                                                           | Default     |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS`, `AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS`                 | How long a session owner may go without a heartbeat before the session is at risk of release; positive integer milliseconds.      | `4000` ms   |
| `AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS`, `AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS`   | How often the daemon checks for expired heartbeats; positive integer milliseconds.                                                | `2000` ms   |
| `AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS`, `AUTO_MOBILE_SESSION_IDLE_TIMEOUT_MS`                           | Idle window after a session's last control call; positive integer milliseconds. Set it in both the daemon and proxy environments. | `120000` ms |
| `AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS`, `AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS`     | Grace period before the first heartbeat of a custom-heartbeat session; positive integer milliseconds.                             | `20000` ms  |
| `AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS`, `AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS` | Grace period for default sessions that never send a heartbeat; positive integer milliseconds.                                     | `5000` ms   |

</div>

```bash
export AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS=20000
```

A device session is released about 10 s after its owner's last heartbeat at the
default settings. The MCP proxy heartbeats automatically, so a late or lost beat
does not lapse the session.

A session also has an idle window (2 minutes by default). Only control calls
(taps, swipes, typing and similar) extend it; heartbeats and read-only calls such
as `observe` do not. An agent that acquires a device and then makes no control
calls for the whole window loses the session and its device, even while its proxy
stays connected. Raise `AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS` if your workflow only
observes for long stretches. See [device ownership](device-ownership.md) for which
tools count as reads.

Idle time includes host sleep, so a laptop that sleeps longer than the window may
lose its session. The next call then fails with `bound_session_lost`; acquire a
new session with `getAndroid` or `getApple`.

If the proxy cannot get heartbeats acknowledged after three recovery attempts, it
returns a structured error on the next call that uses the session:

- `daemon_stalled`: the daemon stopped answering. Restart the daemon, then resume
  by passing the same `sessionUuid` on a tool call.
- `proxy_stalled`: the proxy itself stalled and the daemon released the session.
  Reacquire the device with `getAndroid` or `getApple`.

To restart a proxy and keep its sessions, start it with `--initial-session-uuid`
and a stable `--liveness-owner-token <token>`; use a distinct token per harness.
A one-shot `--cli` call needs no keeper, and `--daemon heartbeat` on a CLI session
is a no-op.

`--daemon session-info <session-id>` prints a session's device, platform,
`lastToolActivityAt`, `idleReleaseAt` and lease `liveness`, plus `stableDeviceId`
(when known), `deviceGeneration` (zero initially), and `previousDeviceId` (after a
serial change). `--daemon active-sessions` includes these binding fields for every
held session.

When a retained session is recovered onto a new serial (not when you move it yourself with
`setActiveDevice` or an explicit bind), its proxy sends an MCP logging
notification at level `info`, logger `auto-mobile.liveness`, with data
`{ code: "session_device_rebound", sessionUuid, previousDeviceId, deviceId,
stableDeviceId?, avdName?, generation }`. `avdName` is the Android AVD name when
known. A client logging threshold above `info` suppresses this notification.
Subsequent admitted daemon tool results also carry
`_meta["automobile/sessionDevice"] = { sessionUuid, deviceId, stableDeviceId?,
generation, previousDeviceId }`; this field is absent before the first serial
change. Compare `sessionUuid` and `stableDeviceId` across results to verify the
same session and device image, with the new `deviceId` and an incremented
`generation`. Generations count serial changes within one daemon lifetime and
restart at zero after a daemon restart. See [device-loss retry guidance](device-ownership.md#when-a-session-is-released).

## CLI session lifetime

<div class="environment-variable-table" markdown>

| Variable                                                                            | Use and accepted values                                                                                                                                                | Default     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS`, `AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS` | Idle timeout for sessions held from `--cli`; integer milliseconds of at least `120000` (smaller or non-numeric values are ignored with a warning), capped at one hour. | `120000` ms |

</div>

Each `--cli` call is its own process and cannot send heartbeats, so a session
used from `--cli` is released after this much time since its last `--cli` tool
call:

```bash
export AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS=600000
```

The value is read per invocation, so a change applies on the next call with no
daemon restart.

## Automatic observation screenshots

<div class="environment-variable-table" markdown>

| Variable                                        | Use and accepted values                                                                                                                                   | Default        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT` | Skip the automatic screenshot after actions; `false` or `0` takes a final screenshot.                                                                     | skip           |
| `AUTOMOBILE_OBSERVE_WAIT_FOR_SKIP_SCREENSHOT`   | Skip the final `observe.waitFor` screenshot; `false` or `0` enables it. Intermediate polls still skip.                                                    | skip           |
| `AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT`         | Screenshot mode: `true`/`1` waits for a fresh screenshot that matches the observation (settled); any other set value selects async. A per-call mode wins. | unset; `async` |
| `AUTOMOBILE_MAX_OBSERVATION_AGE_MS`             | How old a cached view hierarchy may be before it is refreshed; positive integer milliseconds.                                                             | `5000` ms      |

</div>

Explicit `observe` calls keep their own screenshot behavior. Observations taken
automatically after an action, or while resolving `observe.waitFor`, skip
screenshots by default. To get one screenshot from the final result:

```bash
export AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT=false
export AUTOMOBILE_OBSERVE_WAIT_FOR_SKIP_SCREENSHOT=false
```

Settled mode costs roughly 170 ms per Android observation and 20-70 ms per iOS
observation over async. When only one call needs a matching screenshot, pass
`observe({ screenshot: "settled" })` instead of setting the variable.

## Screenshot retention

<div class="environment-variable-table" markdown>

| Variable                                    | Use and accepted values                                                                                                   | Default    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `AUTOMOBILE_SCREENSHOT_CACHE_MB`            | Base screenshot cache capacity; positive MiB.                                                                             | `128` MiB  |
| `AUTOMOBILE_SCREENSHOT_CACHE_PER_DEVICE_MB` | Capacity per active device; positive MiB.                                                                                 | `64` MiB   |
| `AUTOMOBILE_SCREENSHOT_CACHE_CEILING_MB`    | Host cache ceiling; positive MiB, never lowers the base. Frames inside their 10-minute guarantee grow the cache up to it. | `2048` MiB |
| `AUTOMOBILE_SCREENSHOT_KEEP_PER_DEVICE`     | Newest screenshots per device evicted only as a last resort; nonnegative integer, `0` disables fairness.                  | `3`        |

</div>

Capacity is the larger of the base and active devices × per-device capacity,
limited by the ceiling (or the base if larger). A device is active while any of
its screenshots has an unexpired retention guarantee; an incoming capture also
counts. Files without a device identity do not increase capacity. Under pressure,
the byte capacity stays fixed for the eviction pass and is recalculated on the
next admission. Each device's newest screenshots are evicted last, with the incoming
capture counting toward its device's allowance and files already being removed
excluded from that allowance. Capture is still admitted if nothing fits.

## Device behavior

Android rebind command and iOS keep-booted reset budgets scale by the one-minute host
load per CPU core when it exceeds 1, up to the configured maximum. Unknown load uses
the base budget. Setting MAX equal to the base disables scaling. A budget timeout
allows one retry with up to twice the first budget, bounded by MAX. iOS waits for
the abandoned step to settle before retrying; exhausted budgets are reported as
budget-driven fallback reasons.

<div class="environment-variable-table" markdown>

| Variable                                                                              | Use and accepted values                                                                                                                                                                                           | Default                                                           |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AUTOMOBILE_CTRL_PROXY_REBIND_WRITE_TIMEOUT_MS`                                       | Base timeout for each Android accessibility rebind command. Positive integer milliseconds.                                                                                                                        | `5000` ms                                                         |
| `AUTOMOBILE_CTRL_PROXY_REBIND_WRITE_TIMEOUT_MAX_MS`                                   | Ceiling for Android accessibility rebind command timeouts. Positive integer milliseconds.                                                                                                                         | `30000` ms                                                        |
| `AUTOMOBILE_IOS_RESET_STEP_BUDGET_MS`                                                 | Base budget for each iOS keep-booted reset step and health probe. Positive integer milliseconds.                                                                                                                  | `30000` ms                                                        |
| `AUTOMOBILE_IOS_RESET_STEP_BUDGET_MAX_MS`                                             | Ceiling for iOS keep-booted reset step and health probe budgets. Positive integer milliseconds.                                                                                                                   | `120000` ms                                                       |
| `AUTOMOBILE_IOS_WARMUP_DEVICES`                                                       | Comma-separated simulator UDIDs that get startup warm-up and observation streams without a session.                                                                                                               | empty list                                                        |
| `AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES`                                          | Comma-separated Android serials that get appearance sync without a session.                                                                                                                                       | empty list                                                        |
| `AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES`                                       | Comma-separated Android serials that get observation streams without a session.                                                                                                                                   | empty list                                                        |
| `AUTOMOBILE_APPEARANCE_SYNC`                                                          | Sync the host's light/dark appearance to devices; `0`, `false`, `off`, `no` disable.                                                                                                                              | on                                                                |
| `AUTOMOBILE_ALLOW_DEVICE_CREATE`                                                      | Permit emulator and simulator creation; `1`/`true` enables. An explicit `--create-if-missing` flag wins.                                                                                                          | off                                                               |
| `AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS`, `AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS`           | Exact `0` disables session continuity; exact `1` also lets eligible Android emulators be restarted. Other values warn and disable restart.                                                                        | continuity on; restart off                                        |
| `AUTOMOBILE_ANDROID_REBOOT_ON_DEATH`, `AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH`           | Deprecated fallback for `AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS`; same values.                                                                                                                                        | unset                                                             |
| `AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS`, `AUTO_MOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS` | Emulator restarts allowed per window; integer `1..10`.                                                                                                                                                            | `2`                                                               |
| `AUTOMOBILE_DEVICE_RECOVERY_WINDOW_MS`, `AUTO_MOBILE_DEVICE_RECOVERY_WINDOW_MS`       | Window for the restart budget; positive integer milliseconds.                                                                                                                                                     | `900000` ms                                                       |
| `AUTOMOBILE_DEVICE_POOL_MATCHING`, `AUTO_MOBILE_DEVICE_POOL_MATCHING`                 | Which matching device to pick: exact `LATEST`, `RANDOM`, `MINIMUM`.                                                                                                                                               | `LATEST`                                                          |
| `AUTOMOBILE_DEVICE_POOL_AUTOLOCK`, `AUTO_MOBILE_DEVICE_POOL_AUTOLOCK`                 | Require a session UUID for an acquired device and release it when idle; exact `1` enables.                                                                                                                        | off                                                               |
| `AUTOMOBILE_DEVICE_POOL_TIMEOUT`, `AUTO_MOBILE_DEVICE_POOL_TIMEOUT`                   | Autolock idle timeout in **seconds**; positive integer.                                                                                                                                                           | `60` seconds                                                      |
| `AUTOMOBILE_EMULATOR_HEADLESS`                                                        | Exact `true` forces headless, `false` forces a window; other values detect.                                                                                                                                       | headless on macOS and Linux without a display; otherwise windowed |
| `AUTOMOBILE_EMULATOR_AUDIO`                                                           | Exact `false` launches with `-no-audio`.                                                                                                                                                                          | audio on                                                          |
| `AUTOMOBILE_EMULATOR_ARGS`                                                            | Extra emulator arguments as a JSON array of nonempty strings; malformed values fail.                                                                                                                              | empty array                                                       |
| `AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS`                                          | Even emulator console ports (5554-5682) or `emulator-<port>` serials AutoMobile must not use, comma- or whitespace-separated. A blank value allows all.                                                           | `5554` when a session broker config is set; otherwise empty       |
| `AUTOMOBILE_BUNDLETOOL_JAR`                                                           | bundletool-all jar, run with `java`, for `installApp` of `.aab`/`.apks`; otherwise `bundletool` on `PATH`. Never downloaded.                                                                                      | unset                                                             |
| `AUTOMOBILE_IOS_HEADLESS`                                                             | On macOS, exact `true`/`1` runs headless and any other set value shows a window. Non-macOS is always headless.                                                                                                    | detect a graphical login session                                  |
| `AUTOMOBILE_BOOT_CAPACITY_GATE`                                                       | Boot limit check for emulator and simulator cold boots; exact `0` disables it on both platforms. See [Boot capacity](#boot-capacity).                                                                             | on                                                                |
| `AUTOMOBILE_IOS_TEMPLATE_CLONE`                                                       | Clone new iOS simulators from settled templates; off by default until clone isolation (#15327) is device-verified, `1`/`true` opts in. No template yet: normal create.                                            | `false`                                                           |
| `AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE`                                                 | New iOS simulators: `none`, `minimal`, or `catalog-cpu`; `none` opts out; unknown values use `minimal`. Explicit resources override the profile.                                                                  | `minimal`                                                         |
| `AUTOMOBILE_IOS_SIM_CAPACITY_GATE`                                                    | iOS-only override of the gate above: exact `0` disables, exact `1` enables.                                                                                                                                       | unset (follows the shared switch)                                 |
| `AUTOMOBILE_ANDROID_MAX_BOOTED`                                                       | Cap on concurrently booted Android emulators; positive integer. Invalid values are ignored with a warning.                                                                                                        | derived from host RAM and cores, at least 1                       |
| `AUTOMOBILE_ANDROID_BOOT_BUDGET_VCPUS`                                                | `configured` sizes the Android boot limit with the vCPU count the AVD about to boot resolved to (`hardware-qemu.ini`, 4 on AVDs AutoMobile creates) instead of two cores per emulator. Any other value keeps two. | `fixed` (two cores per emulator)                                  |
| `AUTOMOBILE_IOS_SIM_BOOT_CONCURRENCY`                                                 | Concurrent iOS simulator boot bursts; positive integer. Extra boots queue in FIFO order. Invalid values warn and use the derived limit.                                                                           | ceil(host cores / 13), at least 2                                 |
| `AUTOMOBILE_IOS_SIM_MAX_BOOTED`                                                       | Cap on concurrently booted iOS simulators; positive integer. Invalid values are ignored with a warning.                                                                                                           | derived from 60% of host RAM over measured footprint and CPU cost |
| `AUTOMOBILE_WORK_PROFILE_POLL_INTERVAL_MS`                                            | Android work-profile package polling interval; positive integer milliseconds.                                                                                                                                     | `5000` ms                                                         |

</div>

By default the daemon only does background work (iOS warm-up, Android appearance
sync, observation streams) for devices that have a session. List devices in
`AUTOMOBILE_IOS_WARMUP_DEVICES`, `AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES` or
`AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES` to include session-less devices,
for example when only an IDE is attached:

```bash
export AUTOMOBILE_IOS_WARMUP_DEVICES=00000000-0000-0000-0000-000000000001
export AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES=emulator-5554
export AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES=emulator-5554
```

AutoMobile does not create an emulator or simulator by default. To allow it:

```bash
export AUTOMOBILE_ALLOW_DEVICE_CREATE=1
auto-mobile --cli startDevice --platform ios --create-if-missing
```

An explicit `--create-if-missing false` disables creation even when the variable
is set. Remove created devices with `xcrun simctl delete <udid>` or
`avdmanager delete avd -n <name>`.

Invalid `AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS` entries fail at launch.

Session continuity is on by default for sessions bound to an Android emulator or
iOS simulator. If the device connection disappears, AutoMobile keeps the session
and waits for the same AVD or simulator UDID to come back. To turn that off:

```bash
export AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS=0
```

`AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS=1` additionally restarts an Android emulator
that AutoMobile started with `startDevice` or `getAndroid`. Physical devices,
emulators started outside AutoMobile, and iOS simulators are never restarted;
they are only waited for. Restarts are limited by
`AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS` within
`AUTOMOBILE_DEVICE_RECOVERY_WINDOW_MS`.

### Ambient Android and OS variables

Not AutoMobile-specific; these configure platform toolchains and the host.

| Variable                                                                     | Use                                                                                                                                                                        | Default                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_SDK_HOME`                       | Android SDK root used to find the emulator; the first that is set and exists wins.                                                                                         | unset                    |
| `HOME`                                                                       | POSIX home directory; used to find the default Android SDK.                                                                                                                | unset                    |
| `USERPROFILE`                                                                | Windows home directory, used when `HOME` is unset or empty.                                                                                                                | unset                    |
| `PATH`                                                                       | Executable search path; reported in emulator-not-found diagnostics.                                                                                                        | unset                    |
| `JAVA_HOME`                                                                  | Java installation checked by `doctor`; its `bin/java` runs `AUTOMOBILE_BUNDLETOOL_JAR`.                                                                                    | unset                    |
| `DEVELOPER_DIR`                                                              | Xcode developer directory used for the simulator profile cache.                                                                                                            | `xcode-select` selection |
| `DISPLAY`, `WAYLAND_DISPLAY`                                                 | Linux display servers; when neither is set, emulators launch with `-no-window`.                                                                                            | unset                    |
| `USER`, `LOGNAME`                                                            | POSIX account name (`USER` first), used to find the running emulator's advertisement directory.                                                                            | unset                    |
| `XDG_RUNTIME_DIR`                                                            | Linux per-user runtime directory searched for running emulators.                                                                                                           | unset                    |
| `ANTHROPIC_API_KEY`                                                          | Anthropic API key used by vision features when none is configured explicitly.                                                                                              | unset                    |
| `ANDROID_USER_HOME`, `ANDROID_AVD_HOME`, `ANDROID_EMULATOR_HOME`             | Android user, AVD and emulator home overrides used to locate AVD definitions.                                                                                              | unset                    |
| `ComSpec`, `COMSPEC`                                                         | Windows command interpreter used to run `.bat` Android tools (`ComSpec` first).                                                                                            | `cmd.exe`                |
| `LOCALAPPDATA`                                                               | Windows local app data directory used to find the default Android SDK.                                                                                                     | unset                    |
| `Path`                                                                       | Windows spelling of `PATH`, used when `PATH` is unset.                                                                                                                     | unset                    |
| `PATHEXT`                                                                    | Windows executable extensions used to locate `bunx`; only `.com` and `.exe` count.                                                                                         | `.COM;.EXE`              |
| `USERNAME`                                                                   | Windows account name, used in the default daemon state-file names.                                                                                                         | unset                    |
| `ADB_SERVER_SOCKET`, `ANDROID_ADB_SERVER_ADDRESS`, `ANDROID_ADB_SERVER_PORT` | The variables `adb` itself reads. AutoMobile uses them to identify the ADB server so daemons sharing one share device claims. The socket spec wins, then address and port. | `localhost:5037`         |
| `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`                                 | The variables `git` itself reads; a source build uses them to stamp its version.                                                                                           | unset                    |
| `CTRL_PROXY_IOS_BUNDLE_ID`, `CTRL_PROXY_IOS_TIMEOUT`                         | Target app bundle id and runner lifetime in seconds, passed to the iOS CtrlProxy runner.                                                                                   | unset, `86400`           |
| `MCP_SERVER_VERSION`                                                         | Override the reported MCP server version.                                                                                                                                  | unset                    |
| `npm_package_version`                                                        | Package version exported by npm; used only when the manifest version is unavailable.                                                                                       | unset                    |
| `DEBUG_ADB_EXEC`                                                             | Any value logs adb execution with stack traces.                                                                                                                            | unset                    |
| `EMULATOR_POLLING_INTERVAL_MS`                                               | Emulator readiness polling interval in milliseconds; minimum `100`.                                                                                                        | `500`                    |

### Boot capacity

Emulator and simulator cold boots are checked against host capacity by default.
Android and iOS each have a limit: the smaller of the host RAM budget divided by the
per-device memory, and the CPU budget, at least 1. Android budgets half the RAM and
one emulator per 2 cores; iOS budgets 60% of RAM divided by the measured
per-simulator memory footprint (not summed RSS) and half the cores at 0.1 core per
simulator, see [iOS Simulator fleet cost](ios-simulator-fleet-cost.md). Every booted device of
that platform counts, including ones started outside AutoMobile. A simulator
inventory that cannot be read refuses the boot with the retryable
`discovery_incomplete`.

A boot over the limit is refused at once with a retryable error whose
`retryAfterMs` (5 seconds) says when to try again. When emulators AutoMobile did
not start occupy capacity, the message lists them and `externalDevices` carries
their serials:

```json
{
  "success": false,
  "error": "Refused to boot: no emulator capacity (code capacity_exhausted, retryable; retry after 5000ms): 2 emulator(s) booted; limit is 2 (derived). 1 of them were not started by AutoMobile but still count toward the limit: emulator-5554. Shut one down, raise the limit with AUTOMOBILE_ANDROID_MAX_BOOTED or disable the gate with AUTOMOBILE_BOOT_CAPACITY_GATE=0.",
  "code": "capacity_exhausted",
  "retryable": true,
  "retryAfterMs": 5000,
  "limit": 2,
  "booted": 2,
  "platform": "android",
  "externalDevices": ["emulator-5554"]
}
```

For iOS refusals, `heldDevices` lists simulators owned by an AutoMobile session or
broker binding. They count toward the limit, but are not strays: release their
session or binding first. See [device ownership](device-ownership.md).

Adopting an emulator or simulator that is already running is never refused.
`listDevices` reports `capacity` per platform as `{ limit, booted, inFlight }`.

The Android limit is shared by every daemon using the same ADB server on one
host. Daemons given different `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR` values do
not see each other's boots, so they can exceed the limit; give each its own ADB
server as well to isolate their limits.

```bash
export AUTOMOBILE_ANDROID_MAX_BOOTED=3     # fixed Android limit
export AUTOMOBILE_IOS_SIM_MAX_BOOTED=2     # fixed iOS limit
export AUTOMOBILE_BOOT_CAPACITY_GATE=0     # turn the gate off on both platforms
export AUTOMOBILE_IOS_SIM_CAPACITY_GATE=0  # turn it off for iOS only
```

## Shared ADB server

<div class="environment-variable-table" markdown>

| Variable                                                          | Use and accepted values                                                                         | Default |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| `AUTOMOBILE_MANAGED_ADB_SERVER`, `AUTO_MOBILE_MANAGED_ADB_SERVER` | Declare that this process owns the ADB server so a clean shutdown stops it; `1`/`true` enables. | off     |

</div>

By default AutoMobile leaves the local ADB server running. Set
`AUTOMOBILE_MANAGED_ADB_SERVER=1` only when this process owns the server; a clean
shutdown then stops it after active device sessions are released.

## Port allocation

<div class="environment-variable-table" markdown>

| Variable                                                      | Use and accepted values                                                                                                      | Default |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| `AUTOMOBILE_PORT_RANGE_START`, `AUTO_MOBILE_PORT_RANGE_START` | First CtrlProxy host port; positive integer.                                                                                 | `8765`  |
| `AUTOMOBILE_PORT_RANGE_END`, `AUTO_MOBILE_PORT_RANGE_END`     | Last CtrlProxy host port (inclusive), at least the start. Takes precedence over size; invalid values fall back to 100 ports. | unset   |
| `AUTOMOBILE_PORT_RANGE_SIZE`, `AUTO_MOBILE_PORT_RANGE_SIZE`   | Number of CtrlProxy host ports; positive integer, used only without an end.                                                  | `100`   |

</div>

## Assets and CtrlProxy

<div class="environment-variable-table" markdown>

| Variable                                                                                     | Use and accepted values                                                                                                                                   | Default                                                   |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `AUTOMOBILE_VERSION`                                                                         | Release version of downloaded assets; unset, empty or `latest` uses the newest release. Unknown pins fail integrity checks.                               | newest release                                            |
| `AUTOMOBILE_ASSET_BASE_URL`                                                                  | Release asset mirror; absolute HTTPS URL without query or fragment.                                                                                       | `https://github.com/kaeawc/auto-mobile/releases/download` |
| `AUTOMOBILE_ALLOW_INSECURE_ASSET_URL`                                                        | Permit plaintext HTTP asset URLs; `1`/`true` enables.                                                                                                     | off                                                       |
| `AUTOMOBILE_CTRL_PROXY_APK_PATH`                                                             | Use a local Android CtrlProxy APK instead of the released one; filesystem path. Skips the published checksum check.                                       | released/cached APK                                       |
| `AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM`, `AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK` | Skip Android APK checksum checks; `1`/`true` enables.                                                                                                     | off                                                       |
| `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED`                                        | Accept an already-installed APK without checking it during auto-setup and `doctor`; `1`/`true` enables. Device readiness still upgrades a mismatched APK. | off                                                       |
| `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD`                                                        | Use local CtrlProxy sources instead of downloading; `1`/`true` enables.                                                                                   | off                                                       |
| `AUTOMOBILE_IOS_PROTOTYPE_AGENT`                                                             | Local iOS simulator prototype-agent dylib; filesystem path that must exist.                                                                               | local build, then verified release download               |
| `AUTOMOBILE_SKIP_IOS_PROTOTYPE_AGENT_DOWNLOAD`                                               | Do not download the prototype-agent dylib when no verified cached copy exists; `1`/`true` enables.                                                        | off                                                       |
| `AUTOMOBILE_IOS_PROTOTYPE_VIEWER`                                                            | Local viewer template; app directory containing `Info.plist`, relative to the daemon launch directory. Invalid values fail.                               | local build, then verified release download               |
| `AUTOMOBILE_SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD`                                              | Do not download the viewer template when no verified cache exists; `1`/`true` enables.                                                                    | off                                                       |
| `AUTOMOBILE_CTRLPROXY_VERBOSE`                                                               | Verbose iOS CtrlProxy output; `1`/`true` enables.                                                                                                         | off                                                       |
| `AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS`, `AUTO_MOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS`    | iOS runner health poll attempts; positive integer.                                                                                                        | `60`                                                      |
| `AUTOMOBILE_IOS_RUNNER_LAUNCH_CONCURRENCY`                                                   | Maximum concurrent iOS runner launches per daemon; positive integer. Invalid values use the default.                                                      | `2`                                                       |
| `AUTOMOBILE_IPROXY_START_TIMEOUT_MS`, `AUTO_MOBILE_IPROXY_START_TIMEOUT_MS`                  | iOS USB iproxy tunnel startup timeout; positive integer milliseconds.                                                                                     | `5000` ms                                                 |
| `AUTOMOBILE_CWEBP_PATH`                                                                      | Trusted `cwebp` executable; filesystem path. An invalid executable fails.                                                                                 | PATH, bundled or downloaded libwebp                       |
| `AUTOMOBILE_DWEBP_PATH`                                                                      | Trusted `dwebp` executable; filesystem path. An invalid executable fails.                                                                                 | PATH, bundled or downloaded libwebp                       |
| `AUTOMOBILE_FFMPEG`                                                                          | `ffmpeg` executable path or name.                                                                                                                         | `ffmpeg` on PATH                                          |

</div>

To keep an installed CtrlProxy APK through device readiness, set
`AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=1` together with
`AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1`.

### Queued iOS runner launches

When simultaneous cold iOS `observe` calls exceed
`AUTOMOBILE_IOS_RUNNER_LAUNCH_CONCURRENCY`, a read can reach its bounded budget
while its runner launch is queued or already running. It returns `ok: true`, no hierarchy, and
`freshness` with `isFresh: false` and `unavailableReason: "runner_launch_queued"`.
The detail names its queue position when queued, or says the runner is still
starting in the background. Any captured screenshot is kept. The start continues
for up to 60 seconds from the moment its launch leaves the queue (waiting in the
queue is bounded separately, at 5 minutes), and a retry joins that same start.
The same typing applies to a `readiness: none` observe whose read lapses with a
timeout, setup failure, or recovery reason while the device's launch is queued
or holding a launch slot (#15291). Retry the observe shortly.

## iOS builds and signing

<div class="environment-variable-table" markdown>

| Variable                                         | Use and accepted values                                                                             | Default                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `AUTOMOBILE_PROJECT_ROOT`                        | Root used by local iOS CtrlProxy source builds; filesystem path.                                    | process working directory               |
| `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA`         | Derived-data root for local iOS CtrlProxy builds; filesystem path.                                  | data directory `derived-data`           |
| `AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR`            | iOS CtrlProxy bundle cache; filesystem path.                                                        | coordination directory `ctrl-proxy-ios` |
| `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL`           | Custom iOS bundle download URL; HTTPS unless the insecure asset URL opt-in is set.                  | release bundle URL                      |
| `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`             | Local iOS archive or bundle; filesystem path. Wins over the bundle-path override.                   | released bundle                         |
| `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`          | Local iOS runner bundle or archive; filesystem path.                                                | released bundle                         |
| `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256`        | Expected 64-character hex SHA256 of a local or custom runner executable.                            | release checksum                        |
| `AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET` | Which executable the checksum applies to: exact `runner` or `xctest`.                               | release target                          |
| `AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD`      | Pin the hash of a local build after it is built, and reverify it before launch; `1`/`true` enables. | off                                     |
| `AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH`             | Expected device app bundle hash; the device-specific variable wins.                                 | released device app hash                |
| `AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_DEVICE`      | Expected device app bundle hash.                                                                    | generic override or released hash       |
| `AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_SIMULATOR`   | Expected simulator app bundle hash.                                                                 | unset; not verified                     |
| `AUTOMOBILE_IOS_SKIP_CTRL_PROXY_APP_HASH`        | Skip iOS app bundle hash checks; `1`/`true` enables.                                                | off                                     |
| `AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN`         | Make codesign, Gatekeeper or Team ID failures fatal; `1`/`true` enables.                            | off; failures warn                      |
| `AUTOMOBILE_IOS_HELPER_TEAM_ID`                  | Apple Team ID to verify on the downloaded runner bundle.                                            | unset                                   |
| `AUTOMOBILE_IOS_TEAM_IDS`                        | Comma-separated signing Team IDs; wins over the single Team ID.                                     | auto-detected                           |
| `AUTOMOBILE_IOS_TEAM_ID`                         | Single signing Team ID (a comma-separated list also works).                                         | auto-detected                           |
| `AUTOMOBILE_IOS_PROFILE_UUID`                    | Provisioning profile UUID; wins over name and specifier.                                            | automatic discovery                     |
| `AUTOMOBILE_IOS_PROFILE_NAME`                    | Provisioning profile name; wins over specifier.                                                     | automatic discovery                     |
| `AUTOMOBILE_IOS_PROFILE_SPECIFIER`               | Provisioning profile specifier.                                                                     | automatic discovery                     |
| `AUTOMOBILE_IOS_CODE_SIGN_IDENTITY`              | Signing identity.                                                                                   | auto-detected                           |
| `AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH`     | Entitlements file for signing; filesystem path.                                                     | automatic discovery                     |

</div>

## Video recording and capture

<div class="environment-variable-table" markdown>

| Variable                                                                                  | Use and accepted values                                                                                         | Default                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `AUTOMOBILE_VIDEO_QUALITY_PRESET`, `AUTO_MOBILE_VIDEO_QUALITY_PRESET`                     | Recording preset: exact `low`, `medium`, `high`. CLI and per-call options win.                                  | `low`                                  |
| `AUTOMOBILE_VIDEO_TARGET_BITRATE_KBPS`, `AUTO_MOBILE_VIDEO_TARGET_BITRATE_KBPS`           | Target bitrate in kbps; positive integer. Invalid values warn and are ignored. The throughput cap may lower it. | `1000` kbps                            |
| `AUTOMOBILE_VIDEO_MAX_THROUGHPUT_MBPS`, `AUTO_MOBILE_VIDEO_MAX_THROUGHPUT_MBPS`           | Recording throughput cap in Mbps; positive number. Invalid values warn and are ignored.                         | `5` Mbps                               |
| `AUTOMOBILE_VIDEO_FPS`, `AUTO_MOBILE_VIDEO_FPS`                                           | Frames per second; positive integer. The device may clamp it.                                                   | `15` fps                               |
| `AUTOMOBILE_VIDEO_MAX_ARCHIVE_MB`, `AUTO_MOBILE_VIDEO_MAX_ARCHIVE_MB`                     | Recording archive size limit in MB; positive number.                                                            | `100` MB                               |
| `AUTOMOBILE_VIDEO_FORMAT`, `AUTO_MOBILE_VIDEO_FORMAT`                                     | Exact `mp4`; other values warn and are ignored.                                                                 | `mp4`                                  |
| `AUTOMOBILE_VIDEO_RETENTION_DAYS`, `AUTO_MOBILE_VIDEO_RETENTION_DAYS`                     | Days to keep recordings; nonnegative number, `0` disables age expiry.                                           | `7` days                               |
| `AUTOMOBILE_VIDEO_RETENTION_SWEEP_MINUTES`, `AUTO_MOBILE_VIDEO_RETENTION_SWEEP_MINUTES`   | How often expired recordings are removed, in minutes; positive number.                                          | `60` minutes                           |
| `AUTOMOBILE_VIDEO_INPROGRESS_CHECK_SECONDS`, `AUTO_MOBILE_VIDEO_INPROGRESS_CHECK_SECONDS` | How often an active recording's size is checked, in seconds; positive number.                                   | `15` seconds                           |
| `AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE`                                                | Record Android video by piping `screenrecord` through ffmpeg; `1`/`true` enables.                               | off                                    |
| `AUTOMOBILE_VIDEO_SERVER_JAR`                                                             | Local Android video encoder JAR; filesystem path, used only if it exists.                                       | cached/released JAR, then source build |
| `AUTOMOBILE_REQUIRE_VIDEO_SERVER`                                                         | Fail when the video encoder JAR is unavailable instead of degrading; `1`/`true` enables.                        | off                                    |
| `AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD`                                                   | Resolve the video encoder JAR locally only; `1`/`true` enables.                                                 | off                                    |
| `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER`, `AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER`           | Local screen-capture helper executable; filesystem path.                                                        | released helper                        |
| `AUTOMOBILE_NETWORK_FILTER_APP_PATH`                                                      | Local signed Network Filter `.app` for `auto-mobile --ios-network-filter install`.                              | release download                       |
| `AUTOMOBILE_NETWORK_FILTER_TEAM_ID`                                                       | Apple Team ID the Network Filter app and its provider must both be signed by.                                   | shared Developer ID team required      |
| `AUTOMOBILE_IOS_WEBRTC_FFMPEG`, `AUTO_MOBILE_IOS_WEBRTC_FFMPEG`                           | `ffmpeg` executable path or name for iOS WebRTC.                                                                | `ffmpeg` on PATH                       |
| `AUTOMOBILE_IOS_WEBRTC_FORCE_RAW`, `AUTO_MOBILE_IOS_WEBRTC_FORCE_RAW`                     | Force raw iOS capture instead of native H.264; `1`/`true` enables.                                              | off                                    |
| `AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS`                                              | How long to wait to find the simulator window for capture; positive integer milliseconds.                       | `2000` ms                              |

</div>

## WebRTC

<div class="environment-variable-table" markdown>

| Variable                                 | Use and accepted values                                                                                                                        | Default                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT`        | WHIP ingest URL; HTTPS, or loopback HTTP. Remote HTTP requires the insecure-WHIP opt-in. Per-call options win.                                 | unset; required to stream      |
| `AUTOMOBILE_WEBRTC_WHIP_TOKEN`           | Bearer token for WHIP ingest.                                                                                                                  | unset                          |
| `AUTOMOBILE_WEBRTC_ICE_SERVERS`          | JSON array of RTCIceServer objects (`urls`, optional `username`/`credential`) or comma-separated STUN/TURN URLs.                               | `stun:stun.l.google.com:19302` |
| `AUTOMOBILE_WEBRTC_BITRATE_KBPS`         | Encoder bitrate in kbps; positive number.                                                                                                      | encoder/source default         |
| `AUTOMOBILE_WEBRTC_MAX_SIZE`             | Maximum frame size as `WIDTHxHEIGHT`; positive even integers within the H.264 Level 4.2 limit.                                                 | source dimensions              |
| `AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS`    | iOS simulator capture rate; integer `5..60`.                                                                                                   | `15` fps                       |
| `AUTOMOBILE_WEBRTC_ANDROID_FPS`          | Android capture rate; integer `1..60`.                                                                                                         | `30` fps                       |
| `AUTOMOBILE_WEBRTC_TRICKLE_ICE`          | Use WHIP PATCH trickle ICE; `1`, `true`, `yes`, `on` enable.                                                                                   | off                            |
| `AUTOMOBILE_WEBRTC_AUDIO`                | Add an audio track; `1`, `true`, `yes`, `on` enable.                                                                                           | off                            |
| `AUTOMOBILE_WEBRTC_ALLOW_INSECURE_WHIP`  | Permit non-loopback HTTP and arbitrary per-call WHIP overrides; `1`, `true`, `yes`, `on` enable.                                               | off                            |
| `AUTOMOBILE_WEBRTC_WHIP_ALLOWED_ORIGINS` | Comma-separated origins or bare `host[:port]` allowed for per-call WHIP overrides. Loopback and the configured WHIP origin are always allowed. | empty                          |

</div>

## Navigation retention

<div class="environment-variable-table" markdown>

| Variable                                            | Use and accepted values                                                      | Default                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------- |
| `AUTOMOBILE_NAV_RETENTION_SCREENSHOT_TTL_MS`        | How long navigation screenshots are kept; positive integer milliseconds.     | `604800000` ms (7 days)   |
| `AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS`         | How long navigation structure is kept; positive integer milliseconds.        | `7776000000` ms (90 days) |
| `AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS` | Observation cap per app; positive integer.                                   | `50000`                   |
| `AUTOMOBILE_NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS`  | Observation cap across all apps; positive integer.                           | `500000`                  |
| `AUTOMOBILE_NAV_RETENTION_EVICTION_CHUNK_SIZE`      | Rows removed per cleanup batch; positive integer, at most `10000`.           | `5000`                    |
| `AUTOMOBILE_NAV_RETENTION_INTERVAL_MS`              | How often cleanup runs; positive integer milliseconds, at most `2147483647`. | `21600000` ms (6 hours)   |

</div>

## Performance diagnostics

<div class="environment-variable-table" markdown>

| Variable                                                                  | Use and accepted values                                                                                     | Default                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `AUTOMOBILE_OBSERVE_PERF_SNAPSHOT`, `AUTO_MOBILE_OBSERVE_PERF_SNAPSHOT`   | Attach a rolling performance snapshot to observe results; `1`/`true` enables.                               | off                             |
| `AUTOMOBILE_OBSERVE_PERF_WINDOW_MS`, `AUTO_MOBILE_OBSERVE_PERF_WINDOW_MS` | Snapshot window in milliseconds, clamped to `1000..30000`; invalid values fall back.                        | `5000` ms                       |
| `AUTOMOBILE_DISABLE_PERF_AUDIT`                                           | Disable the UI performance audit; `1`/`true` disables.                                                      | off                             |
| `AUTOMOBILE_TOUCH_LATENCY_SAMPLING`                                       | Sample synthetic tap latency; `1`/`true` enables.                                                           | off                             |
| `AUTOMOBILE_TRACE_PROCESSOR`                                              | Perfetto `trace_processor_shell` used to summarize Android `performanceTrace` traces; path or command name. | `trace_processor_shell` on PATH |

</div>

## Testing and internal

These are read by AutoMobile but are meant for testing and diagnostics, not
normal use.

<div class="environment-variable-table" markdown>

| Variable                                   | Use                                                                                                                                                 | Default        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `AUTOMOBILE_HARNESS_PRIVATE_DAEMON`        | Marks a daemon as a short-lived private test daemon: `1` arms the orphan watchdog, `0` exempts it.                                                  | unset          |
| `AUTOMOBILE_DAEMON_LAUNCHER_PID`           | Pid of the process that launched a private test daemon, for the orphan watchdog.                                                                    | parent pid     |
| `AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS` | Idle time after which an orphaned private test daemon exits; milliseconds, `0` disables.                                                            | `900000` ms    |
| `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`      | Record iOS CtrlProxy requests and responses as JSON in this directory; filesystem path.                                                             | off            |
| `AUTOMOBILE_IOS_TAP_STRATEGY`              | Diagnostic iOS tap strategy, at debug log level only: `legacy`, `appRelative`, `appRelativeObserved`, `displayTargeted`, `displayTargetedObserved`. | runner default |
| `AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR`   | Data directory isolated by the unit-test preload.                                                                                                   | unset          |
| `CI`, `GITHUB_ACTIONS`                     | Both exactly `true` on a GitHub Actions runner, where AutoMobile owns the iOS simulator lifecycle.                                                  | unset          |
| `GITHUB_WORKSPACE`                         | GitHub Actions checkout directory, searched for `schemas/test-plan.schema.json`.                                                                    | unset          |
| `NODE_ENV`                                 | Exact `test` arms the test-only guards and test defaults.                                                                                           | unset          |

</div>

Do not use `AUTOMOBILE_DB_PATH=:memory:` in production. Tests may allow it by also setting
`AUTOMOBILE_ALLOW_IN_MEMORY_DB` to `1`, `true` or `yes`.

When template cloning is enabled (opt in with `AUTOMOBILE_IOS_TEMPLATE_CLONE=1`; it is off by default), the first request uses normal creation and starts a background
template build. Later requests can clone a settled, shut-down template for the same runtime,
device type and preboot profile. Template builds consume a boot capacity slot and may take several minutes.

Use `auto-mobile --ios-templates build --runtime <identifier> --device-type <identifier>` to build
one explicitly. Use `auto-mobile --ios-templates clean --all` to remove templates, or replace
`--all` with `--runtime <identifier> --device-type <identifier>` to select one. The selected preboot
profile comes from `AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE`. Cleanup refuses active builds unless
`--force` is supplied. These commands require macOS; explicit maintenance works independently of
the cloning flag. A failed or deferred build exits with status 1; successful build and cleanup exit 0.
