# Environment Variables

Most users can use the defaults. Set these variables when you need a different
state directory, logs, tool set, or device behavior.

## State and logs

<div class="environment-variable-table" markdown>

| Variable                | Use                                                                                                                                         | Default               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `AUTOMOBILE_DATA_DIR`   | Base directory for observe, accessibility, navigation, CtrlProxy-build, screen-streaming, WebRTC, tool-output, and daemon-failure artifacts | `~/.auto-mobile`      |
| `AUTOMOBILE_LOG_DIR`    | Directory for daemon and client logs                                                                                                        | `~/.auto-mobile/logs` |
| `AUTOMOBILE_LOG_FORMAT` | `text` or newline-delimited `json`                                                                                                          | `text`                |
| `AUTOMOBILE_LOG_SINK`   | `file`, `stderr`, or `both`                                                                                                                 | `file`                |

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

## Device behavior

AutoMobile does not create an emulator or simulator by default. The legacy
compatibility path can opt in:

```bash
export AUTOMOBILE_ALLOW_DEVICE_CREATE=1
auto-mobile --cli startDevice --platform ios --create-if-missing
```

An explicit `--create-if-missing false` disables creation even when the
environment variable is set. Created devices can be removed with
`xcrun simctl delete <udid>` or `avdmanager delete avd -n <name>`.

Enable device recovery only when AutoMobile owns the virtual device:

```bash
export AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS=1
export AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS=2
```

Recovery restarts eligible AutoMobile-owned Android AVDs. Physical devices,
externally started emulators, and iOS simulators are not restarted.

## Shared ADB server

By default AutoMobile leaves the local ADB server running. Set
`AUTOMOBILE_MANAGED_ADB_SERVER=1` only when this process owns the server; a
clean shutdown then stops it after active device sessions are released.

The preferred `AUTOMOBILE_*` spelling is documented here. Older
`AUTO_MOBILE_*` aliases are accepted for the state, log, database, recovery,
and ADB settings when the preferred name is unset.
