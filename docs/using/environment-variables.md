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
| `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH` | Overrides the iOS CtrlProxy bundle with a packaged `.ipa` **file** (alias of `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`). This is **not** the way to use a local `xcodebuild` output: a directory makes CtrlProxy iOS setup **fail** (`bundle override is not a file`) in every state except one, and is **bypassed with no diagnostic** only when the runner service is **already running and responding** (cached artifacts alone do not bypass it — setup still reaches the builder and fails). Use `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA` for locally-built runners. |
| `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA` | Derived-data **root** for a locally-built iOS runner (`Build/Products` is appended internally). Only needed when building to a non-default location. Defaults to `/tmp/automobile-ctrl-proxy`, which is where `scripts/ios/ctrl-proxy-build-for-testing.sh` writes. Pair it with `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true`: on a host whose cached bundle metadata is missing or does not match the current version, the daemon downloads the released bundle and extracts it over this directory, replacing the local build. |
| `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD` | Skips Android and iOS CtrlProxy downloads/prefetches when set to `1` or `true`. |
| `AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED` | Skips the accessibility service download when it is already installed. |

## Tool capability defaults (`AUTOMOBILE_TOOLSET_*`)

Advanced tools are hidden behind opt-in **tool capabilities** — off by default so
a fresh MCP session sees only the core surface. These variables set which
capabilities are enabled the moment a session connects; both forms are consulted
and their effects union. Unlike most `AUTOMOBILE_*` variables, they have **no**
legacy `AUTO_MOBILE_*` alias.

| Variable | Purpose |
|----------|---------|
| `AUTOMOBILE_TOOLSET_DEFAULTS` | Comma-separated capability names to enable by default (e.g. `clipboard,telephony`). Unknown names are ignored. |
| `AUTOMOBILE_TOOLSET_<CAP>` | Enable one capability when set to `1`. `<CAP>` is the capability name upper-cased with hyphens replaced by underscores (e.g. `AUTOMOBILE_TOOLSET_ADVANCED_INTERACTION=1`). |

These are only a fallback: an explicit `setToolCapability` choice for a session is
persisted and overrides the default. See
[Tool Capabilities & Registration Flags](tool-capabilities.md) for the full list
of capabilities, the tools each one exposes, and how to toggle them at runtime.

## Device provisioning opt-in

AutoMobile never creates a simulator or emulator by default — spawning devices on
a developer's machine is a side effect they did not ask for. Turn it on
explicitly, per run or per environment.

| Variable | Purpose | Default |
|----------|---------|---------|
| `AUTOMOBILE_ALLOW_DEVICE_CREATE` | When `1` or `true`, `startDevice` creates a device (iOS: `simctl create`; Android: `avdmanager create avd`) instead of failing when nothing matches the requested criteria. | unset (off) |

The equivalent per-call flag is `--create-if-missing` on the device-start path:

```bash
auto-mobile --cli startDevice --platform ios --create-if-missing
```

**Precedence:** an explicit flag wins over the env var, in *both* directions —
`--create-if-missing false` disables creation even when
`AUTOMOBILE_ALLOW_DEVICE_CREATE=1`. With no flag, the env var decides. With
neither, creation is off.

Created devices are named `AutoMobile-<model>-<id>` so they are easy to find and
clean up (`xcrun simctl delete <udid>` / `avdmanager delete avd -n <name>`), and
the resolved device type and runtime are logged at creation time.

## WebRTC screen streaming (`AUTOMOBILE_WEBRTC_*`)

Defaults for pushing a device's screen to a WHIP ingest server (the supported
fanout is [MediaMTX](https://github.com/bluenviron/mediamtx)) over WebRTC/WHIP.
See the [CI worker guide](../webrtc-streaming-ci-worker.md) and the
[design doc](../design-docs/mcp/observe/webrtc-streaming.md). Any value can be
overridden per request on the `webrtc-stream.sock` control socket.

| Variable | Purpose | Default |
|----------|---------|---------|
| `AUTOMOBILE_WEBRTC_WHIP_ENDPOINT` | WHIP ingest URL. For MediaMTX use a per-stream path, e.g. `http://host:8889/<stream>/whip` (the stock config is plain HTTP; enable `webrtcEncryption` for `https://`). Required to start a stream unless passed per request. | unset |
| `AUTOMOBILE_WEBRTC_WHIP_TOKEN` | Bearer token sent as `Authorization: Bearer <token>` on WHIP ingest. | unset |
| `AUTOMOBILE_WEBRTC_ICE_SERVERS` | Comma-separated STUN/TURN URLs, or a JSON array of `{urls,username,credential}`. | `stun:stun.l.google.com:19302` |
| `AUTOMOBILE_WEBRTC_BITRATE_KBPS` | Target encoder bitrate (kbps). | encoder default |
| `AUTOMOBILE_WEBRTC_MAX_SIZE` | Capture downscale as `WIDTHxHEIGHT` (e.g. `720x1280`). | native |
| `AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS` | iOS Simulator WebRTC capture rate. Integer in `[5, 60]`; values outside the range are rejected at stream start. Separate from the generic screen-capture rate used for MCP observation. | `15` |
| `AUTOMOBILE_WEBRTC_ANDROID_FPS` | Android video-server WebRTC capture rate, forwarded to the on-device encoder as `--fps`. Integer in `[1, 60]`; values outside the range are rejected at stream start. Decoupled from the quality preset so the rate can be tuned without changing resolution/bitrate. | `30` |
| `AUTOMOBILE_VIDEO_SERVER_JAR` | Explicit path to a built `automobile-video.jar` (persistent on-device encoder). Highest resolution precedence: when set it is used directly, ahead of the cached/downloaded release jar and the Gradle build output. | (resolution precedence, see below) |
| `AUTOMOBILE_REQUIRE_VIDEO_SERVER` | When `1`/`true`, a degrade-to-`screenrecord` case returns `success: false` with a typed `capture_start_failed` screenshot fallback instead. For CI that must run the persistent encoder. A checksum mismatch has the same typed failure and is never accepted. | unset |
| `AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD` | When `1`/`true`, never fetch the jar from the network: resolve from the local override or Gradle build output only. Dedicated flag — **not** `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD` (the CtrlProxy APK is mandatory; the jar is optional and degrades). | unset |
| `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER` | Explicit local development path to `screen-capture-helper` for iOS WebRTC capture. Build with `swift build` in `ios/screen-capture`, then set this to the resulting absolute path. | verified signed helper downloaded from the matching GitHub Release |
| `AUTOMOBILE_IOS_WEBRTC_FFMPEG` | Path to the `ffmpeg` binary used to encode iOS helper BGRA frames into H.264 Annex-B. | `ffmpeg` on `PATH` |
| `AUTOMOBILE_WEBRTC_TRICKLE_ICE` | Enable trickle ICE: publish the WHIP offer immediately and PATCH candidates incrementally instead of blocking on ICE gathering. Requires an ingest server supporting the WHIP trickle extension. | `false` |
| `AUTOMOBILE_WEBRTC_AUDIO` | Enable optional audio alongside video. Android requires the persistent `video-server` jar and captures shell-privileged `REMOTE_SUBMIX`; iOS supports Simulator-window audio through ScreenCaptureKit. Both emit 8 kHz mono PCM16LE and publish as PCMU. Physical iOS playback capture is unavailable through public APIs. | `false` |

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
