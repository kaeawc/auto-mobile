# Environment Variables

AutoMobile reads a handful of environment variables to control where its SQLite
database lives, how the migration lock behaves, and various diagnostic and
runner-override paths. Most users never need to set any of these — the defaults
work out of the box. They are primarily useful for isolating databases across
worktrees/instances, opting into test-only behavior, and debugging.

Unless a section says otherwise, every `AUTOMOBILE_*` variable also accepts a
legacy `AUTO_MOBILE_*` alias (underscore after `AUTO`). The `AUTOMOBILE_*`
spelling is preferred; the alias is retained for backward compatibility and is
used only when the preferred name is unset.

## State & log locations

| Variable                | Legacy alias             | Purpose                                                                                                                                                                                                                                                         | Default                                       |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `AUTOMOBILE_DATA_DIR`   | `AUTO_MOBILE_DATA_DIR`   | Stable base directory for AutoMobile's non-log state, including caches, screenshots, `tool_logs`, and the default log location.                                                                                                                                 | `~/.auto-mobile`                              |
| `AUTOMOBILE_LOG_DIR`    | `AUTO_MOBILE_LOG_DIR`    | Directory for structured daemon/client logs, rotated logs, and daemon-launch captures. Takes precedence over the `logs` child of `AUTOMOBILE_DATA_DIR` without relocating any non-log state. Relative paths resolve from the daemon's launch working directory. | `${AUTOMOBILE_DATA_DIR:-~/.auto-mobile}/logs` |
| `AUTOMOBILE_LOG_FORMAT` | `AUTO_MOBILE_LOG_FORMAT` | Log record format: `text` (default) or `json` (newline-delimited JSON).                                                                                                                                                                                         | `text`                                        |
| `AUTOMOBILE_LOG_SINK`   | `AUTO_MOBILE_LOG_SINK`   | Log destination: `file` (default), `stderr`, or `both`. JSON logs written to `stderr` never use stdout, preserving MCP stdio protocol correctness.                                                                                                              | `file`                                        |

When no home directory is available and `AUTOMOBILE_DATA_DIR` is unset, the data
directory falls back to `os.tmpdir()/auto-mobile`; the default log directory is
then `os.tmpdir()/auto-mobile/logs`.

For example, keep durable state under one path while routing only logs to a
location collected by your deployment:

```bash
export AUTOMOBILE_DATA_DIR=/var/lib/automobile
export AUTOMOBILE_LOG_DIR=/var/log/automobile
```

For container log collection, opt into newline-delimited JSON on stderr:

```bash
export AUTOMOBILE_LOG_FORMAT=json
export AUTOMOBILE_LOG_SINK=stderr
```

The file sink retains the existing rotation, retention, and sensitive-value
filtering behavior. Invalid format or sink values fall back to the compatible
text/file defaults.

## Database location & behavior (`AUTOMOBILE_DB_*`)

These control where the SQLite database (`auto-mobile.db`) is stored and how the
cross-process migration lock behaves.

| Variable                               | Legacy alias                            | Purpose                                                                                                                                             | Default                         |
| -------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `AUTOMOBILE_DB_PATH`                   | `AUTO_MOBILE_DB_PATH`                   | Explicit path to the database file. Relative paths resolve from the daemon's launch working directory. Takes precedence over `AUTOMOBILE_DB_DIR`.   | `~/.auto-mobile/auto-mobile.db` |
| `AUTOMOBILE_DB_DIR`                    | `AUTO_MOBILE_DB_DIR`                    | Directory that holds `auto-mobile.db`. Relative paths resolve from the daemon's launch working directory. Ignored when `AUTOMOBILE_DB_PATH` is set. | `~/.auto-mobile`                |
| `AUTOMOBILE_ALLOW_IN_MEMORY_DB`        | —                                       | **Test-only** opt-in (`1`/`true`/`yes`) that permits `AUTOMOBILE_DB_PATH=:memory:`. Not for production.                                             | unset                           |
| `AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS` | `AUTO_MOBILE_MIGRATION_LOCK_TIMEOUT_MS` | Ceiling (ms) for the cross-process migration-lock busy-wait, mirroring the daemon timeout knobs.                                                    | `60000` (60s)                   |

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
database is private per connection, so startup migrations run on a _separate_
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

| Variable                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOMOBILE_DAEMON_LAUNCH_CWD`                        | Overrides the working directory used to resolve relative `AUTOMOBILE_DB_PATH` / `AUTOMOBILE_DB_DIR` values.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AUTOMOBILE_DEBUG`                                    | Enables verbose debug logging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AUTOMOBILE_DEBUG_PERF`                               | Enables performance/timing debug output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS`              | Default automation-runner readiness budget used by `startDevice`, from `1000` to `120000` ms (default `30000`) when a request omits `timeoutMs`. An explicit `timeoutMs` is shared with runner readiness unless the per-request `runnerReadinessTimeoutMs` supplies a narrower phase budget. CLI equivalent: `--runner-readiness-timeout-ms`; legacy alias: `AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS`.                                                                                                                                                               |
| `AUTOMOBILE_OBSERVE_PERF_SNAPSHOT`                    | Opt-in (`1`/`true`/`yes`) to attach a windowed performance snapshot (`perfSnapshot`) to `observe` results — fps percentiles, jank, touch latency, CPU, memory. Off by default; enabling it starts continuous per-device sampling. Legacy alias `AUTO_MOBILE_OBSERVE_PERF_SNAPSHOT` (the `AUTOMOBILE_*` name wins when both are set).                                                                                                                                                                                                                                 |
| `AUTOMOBILE_OBSERVE_PERF_WINDOW_MS`                   | Rolling window (ms) for `perfSnapshot`. Default `5000`, clamped to `1000`–`30000`. Legacy alias `AUTO_MOBILE_OBSERVE_PERF_WINDOW_MS` (the `AUTOMOBILE_*` name wins when both are set).                                                                                                                                                                                                                                                                                                                                                                               |
| `AUTOMOBILE_CTRL_PROXY_APK_PATH`                      | Overrides the path to the Android CtrlProxy APK (for testing a locally-built runner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`               | Overrides the iOS CtrlProxy bundle with a packaged `.ipa` **file** (alias of `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`). This is **not** the way to use a local `xcodebuild` output: a directory makes CtrlProxy iOS setup **fail** (`bundle override is not a file`) in every state except one, and is **bypassed with no diagnostic** only when the runner service is **already running and responding** (cached artifacts alone do not bypass it — setup still reaches the builder and fails). Use `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA` for locally-built runners. |
| `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA`              | Derived-data **root** for a locally-built iOS runner (`Build/Products` is appended internally). Only needed when building to a non-default location. Defaults to `/tmp/automobile-ctrl-proxy`, which is where `scripts/ios/ctrl-proxy-build-for-testing.sh` writes. Pair it with `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true`: on a host whose cached bundle metadata is missing or does not match the current version, the daemon downloads the released bundle and extracts it over this directory, replacing the local build.                                       |
| `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD`                 | Skips Android and iOS CtrlProxy downloads/prefetches when set to `1` or `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN`              | When `1`/`true`, a failed `codesign --verify --deep --strict`, a failed `spctl --assess` (notarization), or a pinned-Team-ID mismatch on the downloaded iOS runner becomes a **hard refusal to launch** instead of the default warning. Off by default so dev / self-built / unsigned local helpers still run; code signing is not OS-enforced on the simulator, so this is defense-in-depth on physical devices alongside the SHA-256 integrity re-check. macOS-only (no-op elsewhere).                                                                             |
| `AUTOMOBILE_IOS_HELPER_TEAM_ID`                       | Optional Apple **Team ID** to pin for the downloaded iOS runner. When set, the runner bundle's `TeamIdentifier` must match; a mismatch warns (or refuses launch under `AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN`). Unset by default (no canonical Team ID is shipped). macOS-only.                                                                                                                                                                                                                                                                                     |
| `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED` | Skips the accessibility service download when it is already installed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Exact-tool defaults

| Variable                    | Purpose                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AUTOMOBILE_ENABLED_TOOLS`  | Comma-separated exact, case-sensitive tool names to enable over their built-in defaults (for example `clipboard,sqlQuery`). |
| `AUTOMOBILE_DISABLED_TOOLS` | Comma-separated exact, case-sensitive tool names to disable under their built-in defaults (for example `observe`).          |

Unknown names, wrong casing, and same-layer conflicts fail startup. Repeatable
`--enable-tool` / `--disable-tool` CLI values override these environment
defaults; persisted `setToolEnabled` session choices override both. The retired
`AUTOMOBILE_TOOLSET_*` variables also fail startup. These new exact-tool
variables intentionally have no `AUTO_MOBILE_*` alias. See
[Per-tool Selection & Registration Gates](tool-capabilities.md).

## Device provisioning opt-in

AutoMobile never creates a simulator or emulator by default — spawning devices on
a developer's machine is a side effect they did not ask for. Turn it on
explicitly, per run or per environment.

| Variable                         | Purpose                                                                                                                                                                                                        | Default     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `AUTOMOBILE_ALLOW_DEVICE_CREATE` | Legacy `startDevice` compatibility only: when `1` or `true`, its broad matcher may create a device (iOS: `simctl create`; Android: `avdmanager create avd`). `getAndroid` and `getApple` never create devices. | unset (off) |

The equivalent per-call flag is available only on the hidden compatibility path:

```bash
auto-mobile --cli startDevice --platform ios --create-if-missing
```

**Precedence:** an explicit flag wins over the env var, in _both_ directions —
`--create-if-missing false` disables creation even when
`AUTOMOBILE_ALLOW_DEVICE_CREATE=1`. With no flag, the env var decides. With
neither, creation is off.

Created devices are named `AutoMobile-<model>-<id>` so they are easy to find and
clean up (`xcrun simctl delete <udid>` / `avdmanager delete avd -n <name>`), and
the resolved device type and runtime are logged at creation time.

## Managed ADB server lifecycle

By default, AutoMobile treats the local ADB server as shared infrastructure and
does not stop it at process shutdown. This is safe for developer machines and
for hosts where another service or user may use the same server.

| Variable                        | Legacy alias                     | Purpose                                                                                                                                                                                                     | Default     |
| ------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `AUTOMOBILE_MANAGED_ADB_SERVER` | `AUTO_MOBILE_MANAGED_ADB_SERVER` | When `1` or `true`, declares that the daemon or direct AutoMobile process owns the local ADB server lifecycle. A clean shutdown runs a bounded `adb kill-server` after active device sessions are released. | unset (off) |

Enable this only when the surrounding service scope owns the local ADB server.
Do not enable it for a server shared with another AutoMobile daemon, developer,
or unrelated Android tool. Proxy clients never stop the server; cleanup runs in
the daemon or explicit direct (`--no-proxy`) process that performs Android work.

## Managed-device recovery

| Variable                                  | Legacy alias                               | Purpose                                                                                                                                                                 | Default |
| ----------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS`      | `AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS`      | Enables managed-device recovery after confirmed loss. Only exact `1` enables it; exact `0` disables it. Invalid values warn and disable recovery.                       | `0`     |
| `AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS` | `AUTO_MOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS` | Canonical positive decimal attempt budget per stable AutoMobile-owned device identity. Values are bounded to `1` through `10`; invalid values warn and use the default. | `2`     |

These settings are read once when the daemon starts, logged with their effective
values, and reported by device-pool status. Existing
`AUTOMOBILE_ANDROID_REBOOT_ON_DEATH` / `AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH`
remain migration fallbacks for the enablement setting.

Only AutoMobile-owned virtual devices are eligible. Android restarts its owned
AVD today; externally started emulators, physical devices, and iOS simulators
are never restarted. A confirmed device loss cancels the in-flight operation
and returns the machine-readable `device_lost` tool outcome. When the same AVD
is recovered, the active session is preserved and the outcome reports
`retry.sameSession: true` with `retry.requiresNewSession: false`; retry the
operation with the same session UUID. Exhausted or ineligible recovery releases
the session and reports `retry.sameSession: false` with
`retry.requiresNewSession: true`.

## WebRTC screen streaming (`AUTOMOBILE_WEBRTC_*`)

Defaults for pushing a device's screen to a WHIP ingest server (the supported
fanout is [MediaMTX](https://github.com/bluenviron/mediamtx)) over WebRTC/WHIP.
See the [CI worker guide](../webrtc-streaming-ci-worker.md) and the
[design doc](../design-docs/mcp/observe/webrtc-streaming.md). Any value can be
overridden per request on the `webrtc-stream.sock` control socket.

| Variable                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Default                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT`        | WHIP ingest URL. For MediaMTX use a per-stream path, e.g. `https://host:8889/<stream>/whip`. **Policy (issue #4751):** `https:` is required; plaintext `http:` is permitted **only** for loopback hosts (`127.0.0.0/8`, `localhost`, `::1`) because the bearer token and SDP would otherwise travel in cleartext. Set `AUTOMOBILE_WEBRTC_ALLOW_INSECURE_WHIP=1` to re-permit non-loopback `http:`. Required to start a stream unless passed per request. | unset                                                              |
| `AUTOMOBILE_WEBRTC_WHIP_TOKEN`           | Bearer token sent as `Authorization: Bearer <token>` on WHIP ingest.                                                                                                                                                                                                                                                                                                                                                                                     | unset                                                              |
| `AUTOMOBILE_WEBRTC_ICE_SERVERS`          | Comma-separated STUN/TURN URLs, or a JSON array of `{urls,username,credential}`.                                                                                                                                                                                                                                                                                                                                                                         | `stun:stun.l.google.com:19302`                                     |
| `AUTOMOBILE_WEBRTC_BITRATE_KBPS`         | Target encoder bitrate (kbps).                                                                                                                                                                                                                                                                                                                                                                                                                           | encoder default                                                    |
| `AUTOMOBILE_WEBRTC_MAX_SIZE`             | Capture downscale as `WIDTHxHEIGHT` (e.g. `720x1280`).                                                                                                                                                                                                                                                                                                                                                                                                   | native                                                             |
| `AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS`    | iOS Simulator WebRTC capture rate. Integer in `[5, 60]`; values outside the range are rejected at stream start. Separate from the generic screen-capture rate used for MCP observation.                                                                                                                                                                                                                                                                  | `15`                                                               |
| `AUTOMOBILE_WEBRTC_ANDROID_FPS`          | Android video-server WebRTC capture rate, forwarded to the on-device encoder as `--fps`. Integer in `[1, 60]`; values outside the range are rejected at stream start. Decoupled from the quality preset so the rate can be tuned without changing resolution/bitrate.                                                                                                                                                                                    | `30`                                                               |
| `AUTOMOBILE_VIDEO_SERVER_JAR`            | Explicit path to a built `automobile-video.jar` (persistent on-device encoder). Highest resolution precedence: when set it is used directly, ahead of the cached/downloaded release jar and the Gradle build output.                                                                                                                                                                                                                                     | (resolution precedence, see below)                                 |
| `AUTOMOBILE_REQUIRE_VIDEO_SERVER`        | When `1`/`true`, a degrade-to-`screenrecord` case returns `success: false` with a typed `capture_start_failed` screenshot fallback instead. For CI that must run the persistent encoder. A checksum mismatch has the same typed failure and is never accepted.                                                                                                                                                                                           | unset                                                              |
| `AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD`  | When `1`/`true`, never fetch the jar from the network: resolve from the local override or Gradle build output only. Dedicated flag — **not** `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD` (the CtrlProxy APK is mandatory; the jar is optional and degrades).                                                                                                                                                                                                   | unset                                                              |
| `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER`   | Explicit local development path to `screen-capture-helper` for iOS WebRTC capture. Build with `swift build` in `ios/screen-capture`, then set this to the resulting absolute path.                                                                                                                                                                                                                                                                       | verified signed helper downloaded from the matching GitHub Release |
| `AUTOMOBILE_IOS_WEBRTC_FFMPEG`           | Path to the `ffmpeg` binary used to encode iOS helper BGRA frames into H.264 Annex-B.                                                                                                                                                                                                                                                                                                                                                                    | `ffmpeg` on `PATH`                                                 |
| `AUTOMOBILE_WEBRTC_TRICKLE_ICE`          | Enable trickle ICE: publish the WHIP offer immediately and PATCH candidates incrementally instead of blocking on ICE gathering. Requires an ingest server supporting the WHIP trickle extension.                                                                                                                                                                                                                                                         | `false`                                                            |
| `AUTOMOBILE_WEBRTC_AUDIO`                | Enable optional audio alongside video. Android requires the persistent `video-server` jar and captures shell-privileged `REMOTE_SUBMIX`; iOS supports Simulator-window audio through ScreenCaptureKit. Both emit 8 kHz mono PCM16LE and publish as PCMU. Physical iOS playback capture is unavailable through public APIs.                                                                                                                               | `false`                                                            |
| `AUTOMOBILE_WEBRTC_WHIP_ALLOWED_ORIGINS` | Comma-separated allow-list of origins (or bare `host[:port]`) that a `whipEndpoint` supplied **over the wire** to the `webrtc-stream` socket may target (issue #4751). Loopback and the daemon's own `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` origin are always trusted. An override to any other origin is rejected so a local process cannot exfiltrate the screen to a destination of its choosing.                                                          | unset (only the configured endpoint + loopback allowed)            |
| `AUTOMOBILE_WEBRTC_ALLOW_INSECURE_WHIP`  | **Escape hatch (issue #4751).** When `1`/`true`, re-permits non-loopback plaintext `http:` WHIP endpoints **and** accepts an arbitrary (non allow-listed) `whipEndpoint` override from the wire. For advanced setups only — the bearer token and SDP travel in cleartext over `http:`.                                                                                                                                                                   | `false`                                                            |
| `AUTOMOBILE_DAEMON_STREAM_AUTH`          | Governs authentication of the two live-screen daemon sockets (`webrtc-stream`, `video-stream`). When enabled (the default), a `start`/`subscribe` request must carry a `sessionUuid` that resolves to a live daemon session, and may only target a device owned by that same session (issue #4751, extending the #4655 session mechanism). Set to `0`/`false` to disable the check for clients that cannot yet supply a session UUID.                    | enabled                                                            |

### `automobile-video.jar` resolution

The persistent on-device encoder jar is resolved once at stream start, in this
order: `AUTOMOBILE_VIDEO_SERVER_JAR` override → a valid cached download at
`~/.auto-mobile/video-server/` → a fresh, sha256-verified download from the
GitHub release → the local Gradle build output → else `screenrecord`. The jar is
optional, so an unverifiable version degrades to `screenrecord`; a checksum
**mismatch** returns a typed `capture_start_failed` screenshot fallback and is
never accepted. `AUTOMOBILE_VERSION` (pin one coherent version) and
`AUTOMOBILE_ASSET_BASE_URL` (offline mirror host) apply to the jar download just
as they do to the CtrlProxy APK/IPA. See
[WebRTC streaming — persistent-encoder delivery](../design-docs/mcp/observe/webrtc-streaming.md#persistent-encoder-delivery-automobile-videojar).

### `screen-capture-helper` resolution (iOS)

The iOS WebRTC capture helper is resolved at stream start, in this order:
`AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER` override → a valid cached download at
`~/.auto-mobile/screen-capture-helper/` → a fresh, sha256-verified
download of the prebuilt universal (`arm64`+`x86_64`) helper from the GitHub
release. A normal macOS install therefore needs **no** Swift toolchain — the
helper is downloaded and verified like the CtrlProxy APK/IPA and the
`automobile-video.jar`. `AUTOMOBILE_VERSION` and `AUTOMOBILE_ASSET_BASE_URL`
apply to this download too; a checksum **mismatch** is always fatal. Screen
Recording permission and the `ffmpeg` requirement still apply. Non-macOS installs
never invoke this path.
