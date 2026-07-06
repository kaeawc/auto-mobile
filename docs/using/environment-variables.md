# Environment Variables

AutoMobile reads a handful of environment variables to control where its SQLite
database lives, how the migration lock behaves, and various diagnostic and
runner-override paths. Most users never need to set any of these — the defaults
work out of the box. They are primarily useful for isolating databases across
worktrees/instances, opting into test-only behavior, and debugging.

Every `AUTOMOBILE_*` variable also accepts a legacy `AUTO_MOBILE_*` alias
(underscore after `AUTO`). The `AUTOMOBILE_*` spelling is preferred; the alias is
retained for backward compatibility and is used only when the preferred name is
unset.

## Database location & behavior (`AUTOMOBILE_DB_*`)

These control where the SQLite database (`auto-mobile.db`) is stored and how the
cross-process migration lock behaves.

| Variable | Legacy alias | Purpose | Default |
|----------|--------------|---------|---------|
| `AUTOMOBILE_DB_PATH` | `AUTO_MOBILE_DB_PATH` | Explicit path to the database file. Relative paths resolve from the daemon's launch working directory. Takes precedence over `AUTOMOBILE_DB_DIR`. | `~/.auto-mobile/auto-mobile.db` |
| `AUTOMOBILE_DB_DIR` | `AUTO_MOBILE_DB_DIR` | Directory that holds `auto-mobile.db`. Relative paths resolve from the daemon's launch working directory. Ignored when `AUTOMOBILE_DB_PATH` is set. | `~/.auto-mobile` |
| `AUTOMOBILE_ALLOW_IN_MEMORY_DB` | — | **Test-only** opt-in (`1`/`true`/`yes`) that permits `AUTOMOBILE_DB_PATH=:memory:`. Not for production. | unset |
| `AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS` | `AUTO_MOBILE_MIGRATION_LOCK_TIMEOUT_MS` | Ceiling (ms) for the cross-process migration-lock busy-wait, mirroring the daemon timeout knobs. | `60000` (60s) |

### Isolating a database per worktree/instance

Point `AUTOMOBILE_DB_PATH` (or `AUTOMOBILE_DB_DIR`) at a location unique to the
instance so concurrent daemons do not contend for one file:

```bash
# Explicit file
export AUTOMOBILE_DB_PATH="$PWD/.auto-mobile/auto-mobile.db"

# Or just the directory (auto-mobile.db is created inside it)
export AUTOMOBILE_DB_DIR="$PWD/.auto-mobile"
```

Relative paths are resolved from the daemon's launch working directory, not the
process CWD, so they stay stable even if the daemon later changes directories.

### The `:memory:` sentinel is test-only

`AUTOMOBILE_DB_PATH=:memory:` is **rejected in production**. A SQLite `:memory:`
database is private per connection, so startup migrations run on a *separate*
in-memory database while the daemon's own connection is left migrated-but-empty —
the first schema-dependent query (e.g. against `tool_calls`) then fails with
`no such table`. To avoid that footgun, setting `:memory:` without the opt-in
throws an `ActionableError` at path-resolution time:

```
AUTOMOBILE_DB_PATH=:memory: is not a valid production database. ...
The `:memory:` sentinel is for lifecycle tests only; set
AUTOMOBILE_ALLOW_IN_MEMORY_DB=1 to opt in from a test.
```

Set `AUTOMOBILE_ALLOW_IN_MEMORY_DB=1` only from a test that deliberately wants a
private per-connection in-memory database. For production, point
`AUTOMOBILE_DB_PATH` at a real file or unset it to use the default.

## Diagnostics & runner overrides

The following siblings are read elsewhere in the codebase. They are documented
here for discoverability; most are diagnostic or for advanced testing.

| Variable | Purpose |
|----------|---------|
| `AUTOMOBILE_DAEMON_LAUNCH_CWD` | Overrides the working directory used to resolve relative `AUTOMOBILE_DB_PATH` / `AUTOMOBILE_DB_DIR` values. |
| `AUTOMOBILE_DEBUG` | Enables verbose debug logging. |
| `AUTOMOBILE_DEBUG_PERF` | Enables performance/timing debug output. |
| `AUTOMOBILE_CTRL_PROXY_APK_PATH` | Overrides the path to the Android CtrlProxy APK (for testing a locally-built runner). |
| `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH` | Overrides the path to the iOS CtrlProxy bundle (for testing a locally-built runner). |
| `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD` | Skips Android and iOS CtrlProxy downloads/prefetches when set to `1` or `true`. |
| `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED` | Skips the accessibility service download when it is already installed. |
